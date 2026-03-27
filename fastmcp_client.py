import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from fastmcp.server.auth import OIDCProxy, require_scopes
from fastmcp.server.dependencies import get_access_token
from key_value.aio.stores.filetree import FileTreeStore


def _parse_scopes(value: str | None) -> list[str]:
    if not value:
        return []
    normalized = value.replace(",", " ")
    return [scope.strip() for scope in normalized.split() if scope.strip()]


def _default_base_url() -> str:
    configured = os.getenv("FASTMCP_BASE_URL")
    if configured:
        return configured

    scheme = os.getenv("FASTMCP_SCHEME", "http")
    host = os.getenv("FASTMCP_HOST", "127.0.0.1")
    port = os.getenv("FASTMCP_PORT", "8000")
    return f"{scheme}://{host}:{port}"


def build_auth() -> Any | None:
    provider = os.getenv("FASTMCP_OAUTH_PROVIDER", "").strip().lower()
    if not provider:
        return None

    base_url = _default_base_url()
    storage_dir = Path(
        os.getenv(
            "FASTMCP_AUTH_STORAGE_DIR",
            str(Path(__file__).resolve().parent / ".fastmcp" / "oauth-proxy"),
        )
    )
    jwt_signing_key = os.getenv("FASTMCP_JWT_SIGNING_KEY")
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
        "Unsupported FASTMCP_OAUTH_PROVIDER. Use one of: github, google, oidc."
    )


mcp = FastMCP("OAuth MCP Server", auth=build_auth())


@mcp.tool
def greet(name: str) -> str:
    return f"안녕, {name}!"


@mcp.tool
def get_current_time() -> str:
    return datetime.now().isoformat()


@mcp.tool
async def who_am_i() -> dict[str, Any]:
    try:
        token = get_access_token()
    except Exception:
        token = None

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
    }


@mcp.tool(auth=require_scopes("admin"))
async def admin_ping() -> dict[str, str]:
    return {
        "ok": "true",
        "message": "admin scope confirmed",
    }


if __name__ == "__main__":
    host = os.getenv("FASTMCP_HOST", "127.0.0.1")
    port = int(os.getenv("FASTMCP_PORT", "8000"))
    mcp.run(transport="http", host=host, port=port)
