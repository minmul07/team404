from __future__ import annotations

import html
import json
import time
import uuid
from hashlib import sha256
from pathlib import Path
from typing import Any, Generic, TypeVar

from mcp.server.auth.handlers.metadata import MetadataHandler
from mcp.server.auth.handlers.register import (
    RegistrationErrorResponse,
    stringify_pydantic_error,
)
from mcp.server.auth.json_response import PydanticJSONResponse
from mcp.server.auth.provider import (
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.server.auth.routes import build_metadata, cors_middleware
from mcp.server.auth.settings import ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken
from pydantic import AnyHttpUrl, AnyUrl, BaseModel, ValidationError
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route

from fastmcp.server.auth import AccessToken, OAuthProvider
from fastmcp.server.auth.jwt_issuer import JWTIssuer, derive_jwt_key
from fastmcp.server.auth.redirect_validation import validate_redirect_uri
from fastmcp.utilities.logging import get_logger

logger = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)

DEFAULT_ALLOWED_CLIENT_REDIRECT_URIS = [
    "https://chatgpt.com/connector/oauth/*",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://platform.openai.com/apps-manage/oauth",
    "http://localhost:*",
    "http://127.0.0.1:*",
]
DEFAULT_SCOPES = ["mcp:use", "admin"]
DEFAULT_REQUIRED_SCOPES = ["mcp:use"]
DEFAULT_ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60
DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 30
DEFAULT_AUTH_CODE_EXPIRY_SECONDS = 60 * 5
DEFAULT_PENDING_TRANSACTION_EXPIRY_SECONDS = 60 * 10


class DevUser(BaseModel):
    user_id: str
    name: str
    email: str
    scopes: list[str]

    @property
    def claims(self) -> dict[str, str]:
        return {
            "sub": self.user_id,
            "user_id": self.user_id,
            "name": self.name,
            "email": self.email,
        }


class PendingAuthorization(BaseModel):
    txn_id: str
    client_id: str
    redirect_uri: str
    redirect_uri_provided_explicitly: bool
    state: str | None = None
    code_challenge: str = ""
    scopes: list[str]
    resource: str | None = None
    created_at: float
    expires_at: float


class AuthorizationCodeRecord(AuthorizationCode):
    user_id: str
    user_claims: dict[str, str]
    created_at: float


class AccessTokenRecord(BaseModel):
    token_hash: str
    token_jti: str
    client_id: str
    scopes: list[str]
    expires_at: int
    resource: str | None = None
    user_id: str
    user_claims: dict[str, str]
    refresh_token_hash: str | None = None
    created_at: float


class RefreshTokenRecord(RefreshToken):
    token_hash: str
    token_jti: str
    access_token_hash: str | None = None
    user_id: str
    user_claims: dict[str, str]
    resource: str | None = None
    created_at: float


def _hash_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def _normalize_scopes(scopes: list[str] | None, fallback: list[str]) -> list[str]:
    if not scopes:
        return list(fallback)
    return list(dict.fromkeys(scope for scope in scopes if scope))


class JsonCollection(Generic[T]):
    def __init__(self, directory: Path, model: type[T]) -> None:
        self._directory = directory
        self._directory.mkdir(parents=True, exist_ok=True)
        self._model = model

    def _path_for_key(self, key: str) -> Path:
        return self._directory / f"{sha256(key.encode('utf-8')).hexdigest()}.json"

    async def get(self, key: str) -> T | None:
        path = self._path_for_key(key)
        if not path.exists():
            return None
        return self._model.model_validate_json(path.read_text(encoding="utf-8"))

    async def put(self, key: str, value: T) -> None:
        path = self._path_for_key(key)
        path.write_text(value.model_dump_json(exclude_none=True), encoding="utf-8")

    async def delete(self, key: str) -> None:
        path = self._path_for_key(key)
        if not path.exists():
            raise KeyError(key)
        path.unlink()


class ChatGPTCustomOAuthProvider(OAuthProvider):
    def __init__(
        self,
        *,
        base_url: AnyHttpUrl | str,
        issuer_url: AnyHttpUrl | str | None = None,
        storage_dir: Path,
        jwt_signing_key: str | bytes | None = None,
        allowed_client_redirect_uris: list[str] | None = None,
        dev_users_file: Path | None = None,
        valid_scopes: list[str] | None = None,
        default_scopes: list[str] | None = None,
        required_scopes: list[str] | None = None,
        access_token_expiry_seconds: int = DEFAULT_ACCESS_TOKEN_EXPIRY_SECONDS,
        refresh_token_expiry_seconds: int = DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS,
        auth_code_expiry_seconds: int = DEFAULT_AUTH_CODE_EXPIRY_SECONDS,
        pending_transaction_expiry_seconds: int = DEFAULT_PENDING_TRANSACTION_EXPIRY_SECONDS,
    ) -> None:
        self._valid_scopes = _normalize_scopes(valid_scopes, DEFAULT_SCOPES)
        self._default_scopes = _normalize_scopes(default_scopes, self._valid_scopes)
        self._required_scopes = _normalize_scopes(
            required_scopes, DEFAULT_REQUIRED_SCOPES
        )

        super().__init__(
            base_url=base_url,
            issuer_url=issuer_url,
            client_registration_options=ClientRegistrationOptions(
                enabled=True,
                valid_scopes=self._valid_scopes,
                default_scopes=self._default_scopes,
            ),
            revocation_options=RevocationOptions(enabled=True),
            required_scopes=self._required_scopes,
        )

        self._storage_dir = Path(storage_dir)
        self._storage_dir.mkdir(parents=True, exist_ok=True)
        self._allowed_client_redirect_uris = (
            list(allowed_client_redirect_uris)
            if allowed_client_redirect_uris is not None
            else list(DEFAULT_ALLOWED_CLIENT_REDIRECT_URIS)
        )
        self._dev_users_file = Path(dev_users_file) if dev_users_file else None
        self._access_token_expiry_seconds = access_token_expiry_seconds
        self._refresh_token_expiry_seconds = refresh_token_expiry_seconds
        self._auth_code_expiry_seconds = auth_code_expiry_seconds
        self._pending_transaction_expiry_seconds = pending_transaction_expiry_seconds
        self._jwt_issuer: JWTIssuer | None = None

        if jwt_signing_key is None:
            logger.warning(
                "FASTMCP_JWT_SIGNING_KEY is not set; deriving a development key from the base URL."
            )
            jwt_signing_key = derive_jwt_key(
                low_entropy_material=f"{base_url}|custom-dev",
                salt="fastmcp-custom-oauth",
            )
        elif isinstance(jwt_signing_key, str):
            jwt_signing_key = derive_jwt_key(
                low_entropy_material=jwt_signing_key,
                salt="fastmcp-custom-oauth",
            )
        self._jwt_signing_key = jwt_signing_key

        self._client_store = JsonCollection(
            self._storage_dir / "clients",
            OAuthClientInformationFull,
        )
        self._pending_store = JsonCollection(
            self._storage_dir / "pending",
            PendingAuthorization,
        )
        self._code_store = JsonCollection(
            self._storage_dir / "codes",
            AuthorizationCodeRecord,
        )
        self._access_store = JsonCollection(
            self._storage_dir / "access",
            AccessTokenRecord,
        )
        self._refresh_store = JsonCollection(
            self._storage_dir / "refresh",
            RefreshTokenRecord,
        )

        # Validate the dev users configuration at startup.
        self._load_dev_users()

    def set_mcp_path(self, mcp_path: str | None) -> None:
        super().set_mcp_path(mcp_path)
        if self._resource_url is None:
            return

        self._jwt_issuer = JWTIssuer(
            issuer=str(self.issuer_url),
            audience=str(self._resource_url),
            signing_key=self._jwt_signing_key,
        )

    def get_routes(self, mcp_path: str | None = None) -> list[Route]:
        routes = super().get_routes(mcp_path)
        metadata = self._build_metadata()
        custom_routes: list[Route] = []
        protected_resource_endpoint = None
        authorization_server_endpoint = None

        for route in routes:
            if route.path == "/.well-known/oauth-authorization-server":
                authorization_server_endpoint = cors_middleware(
                    MetadataHandler(metadata).handle,
                    ["GET", "OPTIONS"],
                )
                custom_routes.append(
                    Route(
                        route.path,
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    )
                )
                continue

            if route.path == "/register":
                custom_routes.append(
                    Route(
                        "/register",
                        endpoint=cors_middleware(
                            self._handle_registration,
                            ["POST", "OPTIONS"],
                        ),
                        methods=["POST", "OPTIONS"],
                    )
                )
                continue

            if route.path == "/.well-known/oauth-protected-resource/mcp":
                protected_resource_endpoint = route.endpoint

            custom_routes.append(route)

        if authorization_server_endpoint is not None:
            custom_routes.extend(
                [
                    Route(
                        "/.well-known/oauth-authorization-server/mcp",
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                    Route(
                        "/mcp/.well-known/oauth-authorization-server",
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                    Route(
                        "/.well-known/openid-configuration",
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                    Route(
                        "/.well-known/openid-configuration/mcp",
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                    Route(
                        "/mcp/.well-known/openid-configuration",
                        endpoint=authorization_server_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                ]
            )

        if protected_resource_endpoint is not None:
            custom_routes.extend(
                [
                    Route(
                        "/.well-known/oauth-protected-resource",
                        endpoint=protected_resource_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                    Route(
                        "/mcp/.well-known/oauth-protected-resource",
                        endpoint=protected_resource_endpoint,
                        methods=["GET", "OPTIONS"],
                    ),
                ]
            )

        custom_routes.append(
            Route(
                "/oauth/approve",
                endpoint=self._handle_approval,
                methods=["GET", "POST"],
            )
        )
        return custom_routes

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        return await self._client_store.get(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if client_info.client_id is None:
            raise ValueError("client_id is required for client registration")

        if not client_info.redirect_uris:
            raise ValueError("redirect_uris are required for client registration")

        for redirect_uri in client_info.redirect_uris:
            if not validate_redirect_uri(
                redirect_uri=redirect_uri,
                allowed_patterns=self._allowed_client_redirect_uris,
            ):
                raise ValueError(f"Redirect URI '{redirect_uri}' is not allowed")

        public_client = OAuthClientInformationFull(
            client_id=client_info.client_id,
            client_secret=None,
            client_id_issued_at=client_info.client_id_issued_at,
            client_secret_expires_at=None,
            redirect_uris=client_info.redirect_uris,
            token_endpoint_auth_method="none",
            grant_types=client_info.grant_types,
            response_types=client_info.response_types,
            scope=client_info.scope or " ".join(self._valid_scopes),
            client_name=client_info.client_name,
            client_uri=client_info.client_uri,
            logo_uri=client_info.logo_uri,
            contacts=client_info.contacts,
            tos_uri=client_info.tos_uri,
            policy_uri=client_info.policy_uri,
            jwks_uri=client_info.jwks_uri,
            jwks=client_info.jwks,
            software_id=client_info.software_id,
            software_version=client_info.software_version,
        )
        await self._client_store.put(public_client.client_id, public_client)

    async def authorize(
        self,
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
    ) -> str:
        if client.client_id is None:
            raise AuthorizeError(
                error="invalid_client",
                error_description="Client ID is required.",
            )

        if self._resource_url and params.resource:
            if params.resource.rstrip("/") != str(self._resource_url).rstrip("/"):
                raise AuthorizeError(
                    error="invalid_request",
                    error_description="Requested resource does not match this MCP server.",
                )

        redirect_uri = client.validate_redirect_uri(params.redirect_uri)
        requested_scopes = (
            client.validate_scope(" ".join(params.scopes))
            if params.scopes
            else None
        )
        scopes = _normalize_scopes(
            requested_scopes,
            self._required_scopes,
        )

        txn_id = uuid.uuid4().hex
        transaction = PendingAuthorization(
            txn_id=txn_id,
            client_id=client.client_id,
            redirect_uri=str(redirect_uri),
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            state=params.state,
            code_challenge=params.code_challenge,
            scopes=scopes,
            resource=params.resource or str(self._resource_url) if self._resource_url else None,
            created_at=time.time(),
            expires_at=time.time() + self._pending_transaction_expiry_seconds,
        )
        await self._pending_store.put(txn_id, transaction)

        return f"{str(self.base_url).rstrip('/')}/oauth/approve?txn={txn_id}"

    async def load_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: str,
    ) -> AuthorizationCodeRecord | None:
        record = await self._code_store.get(authorization_code)
        if record is None:
            return None

        if record.client_id != client.client_id:
            return None

        if record.expires_at < time.time():
            await self._code_store.delete(authorization_code)
            return None

        return record

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: AuthorizationCodeRecord,
    ) -> OAuthToken:
        if self._jwt_issuer is None:
            raise TokenError("server_error", "JWT issuer is not initialized.")

        stored = await self._code_store.get(authorization_code.code)
        if stored is None:
            raise TokenError(
                "invalid_grant",
                "Authorization code was not found or was already used.",
            )

        if stored.client_id != client.client_id:
            raise TokenError("invalid_grant", "Authorization code does not match client.")

        if stored.resource and self._resource_url:
            if stored.resource.rstrip("/") != str(self._resource_url).rstrip("/"):
                raise TokenError(
                    "invalid_target",
                    "Authorization code was issued for a different resource.",
                )

        access_token, refresh_token = await self._issue_token_pair(
            client_id=client.client_id or "",
            scopes=stored.scopes,
            user_id=stored.user_id,
            user_claims=stored.user_claims,
            resource=stored.resource,
        )
        await self._code_store.delete(authorization_code.code)

        return OAuthToken(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=self._access_token_expiry_seconds,
            scope=" ".join(stored.scopes),
        )

    async def load_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: str,
    ) -> RefreshTokenRecord | None:
        payload = self._verify_jwt_token(refresh_token, expected_use="refresh")
        if payload is None:
            return None

        record = await self._refresh_store.get(_hash_token(refresh_token))
        if record is None:
            return None

        if record.client_id != client.client_id:
            return None

        if record.expires_at is not None and record.expires_at < int(time.time()):
            await self._revoke_pair(
                access_token_hash=record.access_token_hash,
                refresh_token_hash=record.token_hash,
            )
            return None

        if payload.get("jti") != record.token_jti:
            return None

        return record

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshTokenRecord,
        scopes: list[str],
    ) -> OAuthToken:
        requested_scopes = scopes or refresh_token.scopes
        if not set(requested_scopes).issubset(set(refresh_token.scopes)):
            raise TokenError(
                "invalid_scope",
                "Requested scopes exceed those authorized by the refresh token.",
            )

        await self._revoke_pair(
            access_token_hash=refresh_token.access_token_hash,
            refresh_token_hash=refresh_token.token_hash,
        )
        access_token, new_refresh_token = await self._issue_token_pair(
            client_id=client.client_id or "",
            scopes=requested_scopes,
            user_id=refresh_token.user_id,
            user_claims=refresh_token.user_claims,
            resource=refresh_token.resource,
        )
        return OAuthToken(
            access_token=access_token,
            refresh_token=new_refresh_token,
            expires_in=self._access_token_expiry_seconds,
            scope=" ".join(requested_scopes),
        )

    async def load_access_token(self, token: str) -> AccessToken | None:
        payload = self._verify_jwt_token(token, expected_use="access")
        if payload is None:
            return None

        record = await self._access_store.get(_hash_token(token))
        if record is None:
            return None

        if record.expires_at < int(time.time()):
            await self._revoke_pair(
                access_token_hash=record.token_hash,
                refresh_token_hash=record.refresh_token_hash,
            )
            return None

        if payload.get("jti") != record.token_jti:
            return None

        return AccessToken(
            token=token,
            client_id=record.client_id,
            scopes=record.scopes,
            expires_at=record.expires_at,
            resource=record.resource,
            claims=record.user_claims,
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        token_hash = _hash_token(token.token)
        access_record = await self._access_store.get(token_hash)
        if access_record is not None:
            await self._revoke_pair(
                access_token_hash=access_record.token_hash,
                refresh_token_hash=access_record.refresh_token_hash,
            )
            return

        refresh_record = await self._refresh_store.get(token_hash)
        if refresh_record is not None:
            await self._revoke_pair(
                access_token_hash=refresh_record.access_token_hash,
                refresh_token_hash=refresh_record.token_hash,
            )

    async def _handle_registration(self, request: Request) -> Response:
        try:
            body = await request.json()
            client_metadata = OAuthClientMetadata.model_validate(body)
        except ValidationError as validation_error:
            return PydanticJSONResponse(
                content=RegistrationErrorResponse(
                    error="invalid_client_metadata",
                    error_description=stringify_pydantic_error(validation_error),
                ),
                status_code=400,
            )

        if not {"authorization_code", "refresh_token"}.issubset(
            set(client_metadata.grant_types)
        ):
            return PydanticJSONResponse(
                content=RegistrationErrorResponse(
                    error="invalid_client_metadata",
                    error_description="grant_types must include authorization_code and refresh_token",
                ),
                status_code=400,
            )

        if "code" not in client_metadata.response_types:
            return PydanticJSONResponse(
                content=RegistrationErrorResponse(
                    error="invalid_client_metadata",
                    error_description="response_types must include 'code'",
                ),
                status_code=400,
            )

        scope_string = client_metadata.scope or " ".join(self._valid_scopes)
        requested_scopes = set(scope_string.split())
        valid_scopes = set(self._valid_scopes)
        invalid_scopes = requested_scopes - valid_scopes
        if invalid_scopes:
            return PydanticJSONResponse(
                content=RegistrationErrorResponse(
                    error="invalid_client_metadata",
                    error_description="Requested scopes are not valid: "
                    + ", ".join(sorted(invalid_scopes)),
                ),
                status_code=400,
            )

        for redirect_uri in client_metadata.redirect_uris or []:
            if not validate_redirect_uri(
                redirect_uri=redirect_uri,
                allowed_patterns=self._allowed_client_redirect_uris,
            ):
                return PydanticJSONResponse(
                    content=RegistrationErrorResponse(
                        error="invalid_redirect_uri",
                        error_description=f"Redirect URI '{redirect_uri}' is not allowed.",
                    ),
                    status_code=400,
                )

        issued_at = int(time.time())
        client_info = OAuthClientInformationFull(
            client_id=str(uuid.uuid4()),
            client_secret=None,
            client_id_issued_at=issued_at,
            client_secret_expires_at=None,
            redirect_uris=client_metadata.redirect_uris,
            token_endpoint_auth_method="none",
            grant_types=client_metadata.grant_types,
            response_types=client_metadata.response_types,
            scope=scope_string,
            client_name=client_metadata.client_name,
            client_uri=client_metadata.client_uri,
            logo_uri=client_metadata.logo_uri,
            contacts=client_metadata.contacts,
            tos_uri=client_metadata.tos_uri,
            policy_uri=client_metadata.policy_uri,
            jwks_uri=client_metadata.jwks_uri,
            jwks=client_metadata.jwks,
            software_id=client_metadata.software_id,
            software_version=client_metadata.software_version,
        )
        await self.register_client(client_info)
        return PydanticJSONResponse(content=client_info, status_code=201)

    async def _handle_approval(self, request: Request) -> Response:
        if request.method == "GET":
            txn_id = request.query_params.get("txn")
            if not txn_id:
                return self._html_error("Missing transaction", "The approval request is missing a transaction id.")

            transaction = await self._get_pending_transaction(txn_id)
            if transaction is None:
                return self._html_error("Expired request", "The approval request is missing or has expired.")

            return HTMLResponse(self._render_approval_form(transaction), status_code=200)

        form = await request.form()
        txn_id = form.get("txn")
        user_id = form.get("user_id")
        if not isinstance(txn_id, str) or not isinstance(user_id, str):
            return self._html_error("Invalid submission", "Both transaction id and user id are required.")

        transaction = await self._get_pending_transaction(txn_id)
        if transaction is None:
            return self._html_error("Expired request", "The approval request is missing or has expired.")

        users = self._load_dev_users()
        user = users.get(user_id)
        if user is None:
            return self._html_error("Unknown user", "The selected user was not found.")

        if not set(transaction.scopes).issubset(set(user.scopes)):
            return self._html_error(
                "Insufficient user scopes",
                "The selected user does not have all requested scopes.",
            )

        auth_code = uuid.uuid4().hex
        record = AuthorizationCodeRecord(
            code=auth_code,
            scopes=transaction.scopes,
            expires_at=time.time() + self._auth_code_expiry_seconds,
            client_id=transaction.client_id,
            code_challenge=transaction.code_challenge,
            redirect_uri=AnyUrl(transaction.redirect_uri),
            redirect_uri_provided_explicitly=transaction.redirect_uri_provided_explicitly,
            resource=transaction.resource,
            user_id=user.user_id,
            user_claims=user.claims,
            created_at=time.time(),
        )
        await self._code_store.put(auth_code, record)
        await self._pending_store.delete(txn_id)

        redirect_target = construct_redirect_uri(
            transaction.redirect_uri,
            code=auth_code,
            state=transaction.state,
        )
        return RedirectResponse(url=redirect_target, status_code=302)

    async def _get_pending_transaction(
        self,
        txn_id: str,
    ) -> PendingAuthorization | None:
        transaction = await self._pending_store.get(txn_id)
        if transaction is None:
            return None

        if transaction.expires_at < time.time():
            await self._pending_store.delete(txn_id)
            return None

        return transaction

    def _build_metadata(self):
        metadata = build_metadata(
            self.base_url,
            self.service_documentation_url,
            self.client_registration_options,
            self.revocation_options,
        )
        metadata.token_endpoint_auth_methods_supported = ["none"]
        if metadata.revocation_endpoint:
            metadata.revocation_endpoint_auth_methods_supported = ["none"]
        metadata.scopes_supported = self._valid_scopes
        return metadata

    def _load_dev_users(self) -> dict[str, DevUser]:
        if self._dev_users_file is None:
            users = self._default_users()
            return {user.user_id: user for user in users}

        if not self._dev_users_file.exists():
            logger.warning(
                "FASTMCP_DEV_USERS_FILE %s was not found; using default dev users.",
                self._dev_users_file,
            )
            users = self._default_users()
            return {user.user_id: user for user in users}

        try:
            raw = json.loads(self._dev_users_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"Unable to read FASTMCP_DEV_USERS_FILE {self._dev_users_file}: {exc}"
            ) from exc

        items = raw.get("users", raw) if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            raise ValueError("FASTMCP_DEV_USERS_FILE must contain a JSON list or {'users': [...]} object.")

        users = [DevUser.model_validate(item) for item in items]
        if not users:
            raise ValueError("FASTMCP_DEV_USERS_FILE must define at least one user.")
        return {user.user_id: user for user in users}

    def _default_users(self) -> list[DevUser]:
        return [
            DevUser(
                user_id="demo-user",
                name="Demo User",
                email="demo@example.com",
                scopes=["mcp:use"],
            ),
            DevUser(
                user_id="admin-user",
                name="Admin User",
                email="admin@example.com",
                scopes=["mcp:use", "admin"],
            ),
        ]

    async def _issue_token_pair(
        self,
        *,
        client_id: str,
        scopes: list[str],
        user_id: str,
        user_claims: dict[str, str],
        resource: str | None,
    ) -> tuple[str, str]:
        if self._jwt_issuer is None:
            raise TokenError("server_error", "JWT issuer is not initialized.")

        access_jti = uuid.uuid4().hex
        refresh_jti = uuid.uuid4().hex
        access_token = self._jwt_issuer.issue_access_token(
            client_id=client_id,
            scopes=scopes,
            jti=access_jti,
            expires_in=self._access_token_expiry_seconds,
            upstream_claims=user_claims,
        )
        refresh_token = self._jwt_issuer.issue_refresh_token(
            client_id=client_id,
            scopes=scopes,
            jti=refresh_jti,
            expires_in=self._refresh_token_expiry_seconds,
            upstream_claims=user_claims,
        )

        access_hash = _hash_token(access_token)
        refresh_hash = _hash_token(refresh_token)
        now = time.time()
        expires_at = int(now) + self._access_token_expiry_seconds
        refresh_expires_at = int(now) + self._refresh_token_expiry_seconds

        await self._access_store.put(
            access_hash,
            AccessTokenRecord(
                token_hash=access_hash,
                token_jti=access_jti,
                client_id=client_id,
                scopes=scopes,
                expires_at=expires_at,
                resource=resource or str(self._resource_url) if self._resource_url else resource,
                user_id=user_id,
                user_claims=user_claims,
                refresh_token_hash=refresh_hash,
                created_at=now,
            ),
        )
        await self._refresh_store.put(
            refresh_hash,
            RefreshTokenRecord(
                token=refresh_token,
                client_id=client_id,
                scopes=scopes,
                expires_at=refresh_expires_at,
                token_hash=refresh_hash,
                token_jti=refresh_jti,
                access_token_hash=access_hash,
                user_id=user_id,
                user_claims=user_claims,
                resource=resource or str(self._resource_url) if self._resource_url else resource,
                created_at=now,
            ),
        )
        return access_token, refresh_token

    async def _revoke_pair(
        self,
        *,
        access_token_hash: str | None,
        refresh_token_hash: str | None,
    ) -> None:
        if access_token_hash:
            try:
                await self._access_store.delete(access_token_hash)
            except KeyError:
                pass
        if refresh_token_hash:
            try:
                await self._refresh_store.delete(refresh_token_hash)
            except KeyError:
                pass

    def _verify_jwt_token(
        self,
        token: str,
        *,
        expected_use: str,
    ) -> dict[str, Any] | None:
        if self._jwt_issuer is None:
            return None

        try:
            payload = self._jwt_issuer.verify_token(token)
        except Exception:
            return None

        token_use = payload.get("token_use")
        if expected_use == "access" and token_use == "refresh":
            return None
        if expected_use == "refresh" and token_use != "refresh":
            return None

        return payload

    def _render_approval_form(self, transaction: PendingAuthorization) -> str:
        users = self._load_dev_users()
        resource = html.escape(transaction.resource or "")
        scopes = " ".join(transaction.scopes)
        user_options = "\n".join(
            (
                f"<option value=\"{html.escape(user.user_id)}\">"
                f"{html.escape(user.name)} ({html.escape(user.email)})"
                f"</option>"
            )
            for user in users.values()
        )
        return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Approve MCP Access</title>
    <style>
      body {{
        font-family: Arial, sans-serif;
        margin: 0;
        background: #f4f7fb;
        color: #17202a;
      }}
      main {{
        max-width: 640px;
        margin: 48px auto;
        background: #ffffff;
        border-radius: 12px;
        padding: 32px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      }}
      h1 {{
        margin-top: 0;
      }}
      dl {{
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 12px 16px;
      }}
      dt {{
        font-weight: bold;
      }}
      select, button {{
        width: 100%;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #c9d4e5;
        font-size: 16px;
      }}
      button {{
        margin-top: 20px;
        background: #0b57d0;
        color: white;
        border: none;
        cursor: pointer;
      }}
      .muted {{
        color: #5c6675;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>Approve MCP Access</h1>
      <p class="muted">Development approval page for the ChatGPT-compatible OAuth shim.</p>
      <dl>
        <dt>Client</dt><dd>{html.escape(transaction.client_id)}</dd>
        <dt>Scopes</dt><dd>{html.escape(scopes)}</dd>
        <dt>Resource</dt><dd>{resource or "(default MCP resource)"}</dd>
      </dl>
      <form method="post">
        <input type="hidden" name="txn" value="{html.escape(transaction.txn_id)}">
        <label for="user_id">Approve as user</label>
        <select id="user_id" name="user_id">{user_options}</select>
        <button type="submit">Approve and continue</button>
      </form>
    </main>
  </body>
</html>"""

    def _html_error(self, title: str, message: str) -> HTMLResponse:
        return HTMLResponse(
            f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{html.escape(title)}</title>
  </head>
  <body style="font-family: Arial, sans-serif; margin: 40px;">
    <h1>{html.escape(title)}</h1>
    <p>{html.escape(message)}</p>
  </body>
</html>""",
            status_code=400,
        )
