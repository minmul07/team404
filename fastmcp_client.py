import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import OIDCProxy
from fastmcp.server.dependencies import get_access_token
from key_value.aio.stores.filetree import FileTreeStore
from starlette.middleware import Middleware as ASGIMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from oauth.chatgpt_oauth import (
    DEFAULT_ALLOWED_CLIENT_REDIRECT_URIS,
    ChatGPTCustomOAuthProvider,
)


def _parse_scopes(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = value.replace(",", " ")
    return [scope.strip() for scope in normalized.split() if scope.strip()]


def _oauth_tool_meta(*scopes: str) -> dict[str, Any]:
    return {
        "securitySchemes": [
            {
                "type": "oauth2",
                "scopes": list(scopes),
            }
        ]
    }


def _default_base_url() -> str:
    configured = os.getenv("FASTMCP_BASE_URL")
    if configured:
        return configured

    scheme = os.getenv("FASTMCP_SCHEME", "http")
    host = os.getenv("FASTMCP_HOST", "127.0.0.1")
    port = os.getenv("FASTMCP_PORT", "8000")
    return f"{scheme}://{host}:{port}"


def _current_token() -> Any | None:
    try:
        return get_access_token()
    except Exception:
        return None


def _require_runtime_scopes(*required_scopes: str) -> None:
    token = _current_token()
    if token is None:
        raise ToolError("Authentication required")

    token_scopes = set(token.scopes)
    missing = [scope for scope in required_scopes if scope not in token_scopes]
    if missing:
        raise ToolError(f"Missing required scope: {', '.join(missing)}")


class MCPContentTypeCompatibilityMiddleware:
    """Normalize legacy ChatGPT MCP POST content types to JSON."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http" and scope.get("path") == "/mcp":
            headers = list(scope.get("headers", []))
            rewritten = False

            for index, (key, value) in enumerate(headers):
                if key.lower() != b"content-type":
                    continue
                media_type = value.split(b";", 1)[0].strip().lower()
                if media_type == b"application/octet-stream":
                    headers[index] = (key, b"application/json")
                    rewritten = True
                    break

            if rewritten:
                scope = dict(scope)
                scope["headers"] = headers

        await self.app(scope, receive, send)


def build_auth() -> Any | None:
    provider = os.getenv("FASTMCP_OAUTH_PROVIDER", "custom").strip().lower()
    if provider in {"", "none", "off", "disabled", "false", "0"}:
        return None

    base_url = _default_base_url()
    default_storage_dir = ".fastmcp/custom-oauth"
    if provider != "custom":
        default_storage_dir = ".fastmcp/oauth-proxy"
    storage_dir = Path(
        os.getenv(
            "FASTMCP_AUTH_STORAGE_DIR",
            str(Path(__file__).resolve().parent / default_storage_dir),
        )
    )
    jwt_signing_key = os.getenv("FASTMCP_JWT_SIGNING_KEY")

    if provider == "custom":
        allowed_redirect_uris = _parse_scopes(
            os.getenv("FASTMCP_ALLOWED_CLIENT_REDIRECT_URIS")
        ) or list(DEFAULT_ALLOWED_CLIENT_REDIRECT_URIS)
        dev_users_file = os.getenv("FASTMCP_DEV_USERS_FILE")

        return ChatGPTCustomOAuthProvider(
            base_url=base_url,
            issuer_url=os.getenv("FASTMCP_ISSUER_URL"),
            storage_dir=storage_dir,
            jwt_signing_key=jwt_signing_key,
            allowed_client_redirect_uris=allowed_redirect_uris,
            dev_users_file=Path(dev_users_file) if dev_users_file else None,
        )

    client_storage = FileTreeStore(data_directory=storage_dir)

    if provider == "github":
        from fastmcp.server.auth.providers.github import GitHubProvider

        client_id = os.environ["FASTMCP_GITHUB_CLIENT_ID"]
        client_secret = os.environ["FASTMCP_GITHUB_CLIENT_SECRET"]
        redirect_path = os.getenv("FASTMCP_REDIRECT_PATH", "/auth/callback")

        return GitHubProvider(
            client_id=client_id,
            client_secret=client_secret,
            base_url=base_url,
            redirect_path=redirect_path,
            client_storage=client_storage,
            jwt_signing_key=jwt_signing_key,
        )

    if provider == "google":
        from fastmcp.server.auth.providers.google import GoogleProvider

        client_id = os.environ["FASTMCP_GOOGLE_CLIENT_ID"]
        client_secret = os.environ["FASTMCP_GOOGLE_CLIENT_SECRET"]
        redirect_path = os.getenv("FASTMCP_REDIRECT_PATH", "/auth/callback")
        required_scopes = _parse_scopes(
            os.getenv(
                "FASTMCP_GOOGLE_REQUIRED_SCOPES",
                "openid https://www.googleapis.com/auth/userinfo.email",
            )
        )

        return GoogleProvider(
            client_id=client_id,
            client_secret=client_secret,
            base_url=base_url,
            redirect_path=redirect_path,
            required_scopes=required_scopes,
            client_storage=client_storage,
            jwt_signing_key=jwt_signing_key,
        )

    if provider == "oidc":
        config_url = os.environ["FASTMCP_OIDC_CONFIG_URL"]
        client_id = os.environ["FASTMCP_OIDC_CLIENT_ID"]
        client_secret = os.environ["FASTMCP_OIDC_CLIENT_SECRET"]
        redirect_path = os.getenv("FASTMCP_REDIRECT_PATH", "/auth/callback")
        audience = os.getenv("FASTMCP_OIDC_AUDIENCE")
        required_scopes = _parse_scopes(os.getenv("FASTMCP_OIDC_REQUIRED_SCOPES"))

        return OIDCProxy(
            config_url=config_url,
            client_id=client_id,
            client_secret=client_secret,
            base_url=base_url,
            redirect_path=redirect_path,
            audience=audience,
            required_scopes=required_scopes or None,
            client_storage=client_storage,
            jwt_signing_key=jwt_signing_key,
        )

    raise ValueError(
        "Unsupported FASTMCP_OAUTH_PROVIDER. Use one of: custom, github, google, oidc, none."
    )


mcp = FastMCP("OAuth MCP Server", auth=build_auth())


@mcp.custom_route("/", methods=["GET"])
async def root_info(_: Request) -> JSONResponse:
    auth_enabled = mcp.auth is not None
    return JSONResponse(
        {
            "name": mcp.name,
            "mcp_path": "/mcp",
            "auth_enabled": auth_enabled,
            "auth_provider": os.getenv("FASTMCP_OAUTH_PROVIDER", "custom"),
            "oauth_metadata_url": (
                "/.well-known/oauth-authorization-server" if auth_enabled else None
            ),
            "protected_resource_metadata_url": (
                "/.well-known/oauth-protected-resource/mcp"
                if auth_enabled
                else None
            ),
        }
    )


@mcp.tool(
    meta=_oauth_tool_meta("mcp:use"),
)
def greet(name: str) -> str:
    return f"안녕, {name}!"


@mcp.tool(
    meta=_oauth_tool_meta("mcp:use"),
)
def get_current_time() -> str:
    return datetime.now().isoformat()


@mcp.tool(
    meta=_oauth_tool_meta("mcp:use"),
)
async def who_am_i() -> dict[str, Any]:
    token = _current_token()

    if token is None:
        return {
            "authenticated": False,
            "message": "OAuth provider is not configured or no token was supplied.",
        }

    return {
        "authenticated": True,
        "client_id": token.client_id,
        "scopes": token.scopes,
        "claims": token.claims,
        "resource": token.resource,
    }


@mcp.tool(
    meta=_oauth_tool_meta("admin"),
)
async def admin_ping() -> dict[str, str]:
    _require_runtime_scopes("admin")
    return {
        "ok": "true",
        "message": "admin scope confirmed",
    }


if __name__ == "__main__":
    host = os.getenv("FASTMCP_HOST", "127.0.0.1")
    port = int(os.getenv("FASTMCP_PORT", "8000"))
    mcp.run(
        transport="http",
        host=host,
        port=port,
        json_response=True,
        middleware=[ASGIMiddleware(MCPContentTypeCompatibilityMiddleware)],
    )
