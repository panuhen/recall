"""Authentication / identity resolution.

Paths:
- REST API (from the web BFF): the BFF validates the web session (MSAL in
  entra mode, Better Auth in betterauth mode) and forwards X-User-* headers
  over the trusted internal network. `resolve_identity` reads them (falling
  back to the dev stub user when AUTH_MODE=dev).
- MCP (from AI assistants): FastMCP's `AzureProvider` (see `build_mcp_auth`)
  runs the browser OAuth flow against Entra and validates the returned JWT.
  `mcp_identity` reads the validated token's claims (falling back to the dev
  stub user when AUTH_MODE=dev, so /mcp is usable locally without OAuth).
- MCP (from a trusted backend that already holds the user's identity): a
  delegated Entra access token for this API, obtained by that backend via the
  On-Behalf-Of flow, may be presented directly as the bearer. It is validated
  by a plain `JWTVerifier` (see `_build_delegated_verifier`) chained after the
  `AzureProvider`; the user is resolved from the same claims, so authorship
  and workspace rights are the human's, never the backend's.
- MCP in betterauth mode: the web app's Better Auth `mcp()` plugin is the OAuth
  2.1 authorization server (with dynamic client registration); this backend is
  only a resource server. Its access tokens are opaque, so
  `BetterAuthTokenVerifier` validates each one against Better Auth's
  `/mcp/get-session` and reads email/name from the `ba_user` table.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Optional

import httpx
import jwt
from fastmcp.server.auth import AccessToken, RemoteAuthProvider, TokenVerifier
from fastmcp.server.auth.providers.jwt import JWTVerifier
from jwt import PyJWKClient
from mcp.server.auth.routes import build_resource_metadata_url, cors_middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import config

log = logging.getLogger("recall.auth")


def resolve_identity(request: Request) -> Optional[dict]:
    """Resolve the caller from BFF-injected headers (or the dev stub user).

    Same contract in entra and betterauth mode: `x-user-id` is the provider's
    user id (Entra oid / Better Auth user id), `x-user-upn` the email."""
    oid = request.headers.get("x-user-id")
    upn = request.headers.get("x-user-upn")
    name = request.headers.get("x-user-name")

    if config.AUTH_MODE == "dev":
        return {
            "oid": oid or config.DEV_USER["oid"],
            "upn": upn or config.DEV_USER["upn"],
            "name": name or config.DEV_USER["name"],
        }

    if not oid or not upn:
        return None
    return {"oid": oid, "upn": upn, "name": name or ""}


_jwks_client: Optional[PyJWKClient] = None


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        url = (
            f"https://login.microsoftonline.com/"
            f"{config.AZURE_TENANT_ID}/discovery/v2.0/keys"
        )
        _jwks_client = PyJWKClient(url)
    return _jwks_client


def verify_entra_token(token: str) -> Optional[dict]:
    """Validate an Entra access token; return claims or None.

    Pins the tenant (`tid`) to our directory — the robust "only our
    organisation" gate, stronger than matching the email domain.
    """
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=config.AZURE_API_AUDIENCE or config.AZURE_CLIENT_ID,
            options={"require": ["exp", "iss", "aud"]},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Entra token validation failed: %s", exc)
        return None

    if config.AZURE_TENANT_ID and claims.get("tid") != config.AZURE_TENANT_ID:
        log.warning("token tenant (tid) mismatch")
        return None

    allowed_iss = {
        f"https://login.microsoftonline.com/{config.AZURE_TENANT_ID}/v2.0",
        f"https://sts.windows.net/{config.AZURE_TENANT_ID}/",
    }
    if config.AZURE_TENANT_ID and claims.get("iss") not in allowed_iss:
        log.warning("token issuer mismatch: %s", claims.get("iss"))
        return None

    return claims


# ── MCP OAuth (FastMCP AzureProvider) ───────────────────────


def _build_delegated_verifier() -> Optional[JWTVerifier]:
    """Build the verifier for *delegated* Entra tokens presented directly.

    The ``AzureProvider`` is an OAuth *proxy*: it accepts only the tokens it
    issued itself during a browser sign-in. A trusted backend that already
    holds the user's identity (an agent platform, a chat host, an automation
    server) instead exchanges the user's token for one audienced to this API
    via the On-Behalf-Of flow and presents that Entra token as the bearer. This
    verifier validates such a token against the tenant's JWKS / issuer /
    audience and requires this app's own delegated scope(s) (``MCP_SCOPES``,
    default ``access``) in ``scp``. The token carries the real user's ``oid`` /
    ``preferred_username``, so ``mcp_identity`` resolves the human exactly as
    for the browser flow. Returns ``None`` when the app isn't configured.
    """
    if not config.AZURE_TENANT_ID or not config.AZURE_CLIENT_ID:
        return None
    tenant = config.AZURE_TENANT_ID
    audience = [config.AZURE_CLIENT_ID]
    if config.AZURE_API_AUDIENCE:
        audience.append(config.AZURE_API_AUDIENCE)
    return JWTVerifier(
        jwks_uri=f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
        issuer=[
            f"https://login.microsoftonline.com/{tenant}/v2.0",
            f"https://sts.windows.net/{tenant}/",
        ],
        audience=audience,
        algorithm="RS256",
        required_scopes=config.MCP_SCOPES or ["access"],
    )


# ── MCP OAuth (Better Auth as authorization server) ─────────

# Rejected tokens are cached too, bounded because the caller controls the key
# space; successes are bounded the same way for symmetry.
_BA_CACHE_MAX = 10_000


class BetterAuthTokenVerifier(TokenVerifier):
    """Validate Better Auth's opaque MCP access tokens.

    Better Auth exposes no RFC 7662 introspection endpoint; its own resource
    server helper calls `GET {basePath}/mcp/get-session` with the bearer, so we
    do the same. That endpoint answers 200 with a JSON `null` body for an
    invalid or expired token, so the status code alone proves nothing. (The
    advertised `/mcp/userinfo` does not exist in better-auth 1.6.)

    Both verdicts are cached per token for `cache_ttl` seconds: without a
    negative cache every request with a garbage bearer would cost one call to
    the web app, a request-for-request amplification against it. A rejected
    token never becomes valid, so caching the rejection is safe. Upstream
    trouble (5xx, other 4xx, network errors) is never cached, or an outage
    would keep rejecting valid tokens after it ends.

    The claims carry `oid` = Better Auth user id plus `email` / `name` from
    `ba_user`, so `mcp_identity` resolves them exactly like Entra claims.
    """

    def __init__(
        self,
        *,
        internal_url: str,
        allowed: list[str] | None = None,
        cache_ttl: int = 60,
        cache_max: int = _BA_CACHE_MAX,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        super().__init__()
        self.session_url = f"{internal_url.rstrip('/')}/api/auth/mcp/get-session"
        self.allowed = allowed  # config.BETTER_AUTH_ALLOWED: None = open
        self.cache_ttl = cache_ttl
        self.cache_max = cache_max
        self._transport = transport  # tests inject an httpx.MockTransport
        self._valid: dict[str, tuple[float, AccessToken]] = {}
        self._rejected: dict[str, float] = {}

    # Crude but bounded: a flood pays a full refill, the cache never grows past
    # the cap.
    def _put(self, cache: dict, token: str, value) -> None:
        if len(cache) >= self.cache_max:
            cache.clear()
        cache[token] = value

    def _reject(self, token: str) -> None:
        self._put(self._rejected, token, time.monotonic() + self.cache_ttl)

    def _cached(self, token: str) -> tuple[bool, Optional[AccessToken]]:
        """(hit, result) from either cache, evicting expired entries."""
        now = time.monotonic()
        hit = self._valid.get(token)
        if hit is not None:
            if hit[0] >= now:
                return True, hit[1]
            del self._valid[token]
        expires_at = self._rejected.get(token)
        if expires_at is not None:
            if expires_at >= now:
                return True, None
            del self._rejected[token]
        return False, None

    async def _load_user(self, user_id: str) -> Optional[dict]:
        """email/name from Better Auth's user table (same database as recall)."""
        from .state import get_pool  # lazy: keep this module import-light

        pool = await get_pool()
        row = await pool.fetchrow(
            "SELECT id, email, name FROM ba_user WHERE id = $1", user_id
        )
        return dict(row) if row else None

    async def verify_token(self, token: str) -> Optional[AccessToken]:
        hit, cached = self._cached(token)
        if hit:
            return cached

        try:
            async with httpx.AsyncClient(timeout=5.0, transport=self._transport) as client:
                resp = await client.get(
                    self.session_url, headers={"Authorization": f"Bearer {token}"}
                )
        except httpx.HTTPError as exc:
            log.error("Better Auth get-session unreachable: %s", exc)
            return None

        if resp.status_code == 401:
            self._reject(token)
            return None
        if resp.status_code >= 400:
            log.error("Better Auth get-session returned %s", resp.status_code)
            return None

        try:
            session = resp.json()
        except ValueError:
            log.error("Better Auth get-session returned a non-JSON body")
            return None
        user_id = session.get("userId") if isinstance(session, dict) else None
        if not user_id:
            self._reject(token)
            return None

        user = await self._load_user(user_id)
        if user is None:
            # Token outlived its user row; not cached, it costs one lookup.
            log.warning("Better Auth token for unknown user %s", user_id)
            return None
        if not may_access(self.allowed, user["email"] or ""):
            # Address removed from BETTER_AUTH_ALLOWED_EMAILS: the token is
            # still live in Better Auth, but this user no longer gets in.
            log.info("Better Auth token refused: %s is not on the access list", user_id)
            self._reject(token)
            return None

        expires_at = _epoch(session.get("accessTokenExpiresAt"))
        scope = session.get("scopes") or ""
        access = AccessToken(
            token=token,
            client_id=session.get("clientId") or "",
            scopes=scope.split(),
            expires_at=expires_at,
            subject=user_id,
            claims={
                "sub": user_id,
                "oid": user_id,
                "email": user["email"] or "",
                "name": user["name"] or "",
                "client_id": session.get("clientId"),
                "scope": scope,
            },
        )
        ttl = self.cache_ttl
        if expires_at is not None:
            ttl = min(ttl, expires_at - time.time())
        if ttl > 0:
            self._put(self._valid, token, (time.monotonic() + ttl, access))
        return access


def may_access(allowed: list[str] | None, email: str) -> bool:
    """Whether `email` is on the betterauth access list (None = open). Entries
    are addresses or "@domain" suffixes; mirrors mayAccess() in the web app."""
    if allowed is None:
        return True
    e = email.strip().lower()
    return any(e.endswith(a) if a.startswith("@") else e == a for a in allowed)


def _epoch(value) -> Optional[int]:
    """Better Auth serialises dates as ISO-8601 strings (`...Z`)."""
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


class BetterAuthProvider(RemoteAuthProvider):
    """RemoteAuthProvider whose protected-resource metadata keeps the issuer verbatim.

    The MCP SDK's `create_protected_resource_routes` types
    `authorization_servers` as `list[AnyHttpUrl]`, and Pydantic normalises a
    bare origin by appending a slash — advertising `http://host/` while Better
    Auth's own authorization-server metadata says `http://host`. RFC 8414 wants
    the two byte-identical, and a strict client (Claude.ai) fails the connect
    at "couldn't register". So the RFC 9728 route is hand-rolled, at the exact
    path the 401's WWW-Authenticate advertises.
    """

    def __init__(self, token_verifier: TokenVerifier, issuer: str, base_url: str):
        super().__init__(
            token_verifier=token_verifier,
            authorization_servers=[issuer],  # type: ignore[list-item] — kept a str
            base_url=base_url,
            resource_name="recall",
        )
        self.issuer = issuer

    def get_routes(self, mcp_path: str | None = None) -> list[Route]:
        self.set_mcp_path(mcp_path)
        resource_url = self._get_resource_url(mcp_path)
        if resource_url is None:
            return []
        body = {
            "resource": str(resource_url),
            "authorization_servers": [self.issuer],
            "bearer_methods_supported": ["header"],
            "resource_name": self.resource_name,
        }

        async def metadata(_request: Request) -> JSONResponse:
            return JSONResponse(body, headers={"Cache-Control": "public, max-age=3600"})

        path = httpx.URL(str(build_resource_metadata_url(resource_url))).path
        return [
            Route(
                path,
                endpoint=cors_middleware(metadata, ["GET", "OPTIONS"]),
                methods=["GET", "OPTIONS"],
            )
        ]


def _build_betterauth_auth():
    """The /mcp provider for betterauth mode, or None (open) when unconfigured."""
    if not config.BETTER_AUTH_URL:
        log.warning(
            "MCP auth: betterauth mode but BETTER_AUTH_URL unset — /mcp left "
            "UNAUTHENTICATED."
        )
        return None
    try:
        verifier = BetterAuthTokenVerifier(
            internal_url=config.BETTER_AUTH_INTERNAL_URL or config.BETTER_AUTH_URL,
            allowed=config.BETTER_AUTH_ALLOWED,
            cache_ttl=config.BETTER_AUTH_TOKEN_CACHE_TTL,
        )
        provider = BetterAuthProvider(
            verifier, issuer=config.BETTER_AUTH_URL, base_url=config.MCP_PUBLIC_URL
        )
    except Exception as exc:  # noqa: BLE001
        log.error("MCP auth: failed to build Better Auth provider (%s) — /mcp open", exc)
        return None
    log.info("MCP auth: Better Auth resource server (issuer %s)", config.BETTER_AUTH_URL)
    return provider


def build_mcp_auth():
    """Build the FastMCP auth provider for /mcp, or None to leave it open.

    In "betterauth" mode returns a :class:`BetterAuthProvider` (resource server
    for Better Auth's opaque tokens). Otherwise returns an ``AzureProvider``
    (Entra OAuth via an OAuthProxy: one registered confidential app, browser
    consent, standard client discovery) when running in "entra" mode with the
    client secret configured, wrapped in a ``MultiAuth`` that also accepts
    delegated Entra tokens presented directly
    (see :func:`_build_delegated_verifier`). Otherwise returns None so /mcp is
    unauthenticated — the local-dev default, where `mcp_identity` serves the
    stub user. Never raises: a misconfiguration logs a warning and degrades to
    open rather than crashing the whole backend (REST included).
    """
    if config.AUTH_MODE == "betterauth":
        return _build_betterauth_auth()
    if config.AUTH_MODE != "entra":
        log.info("MCP auth: dev mode — /mcp is open, using the stub user")
        return None
    missing = [
        n
        for n, v in (
            ("AZURE_TENANT_ID", config.AZURE_TENANT_ID),
            ("AZURE_CLIENT_ID", config.AZURE_CLIENT_ID),
            ("AZURE_CLIENT_SECRET", config.AZURE_CLIENT_SECRET),
        )
        if not v
    ]
    if missing:
        log.warning(
            "MCP auth: entra mode but %s unset — /mcp left UNAUTHENTICATED. "
            "Set them to enable the OAuth flow.",
            ", ".join(missing),
        )
        return None
    try:
        from fastmcp.server.auth.auth import MultiAuth
        from fastmcp.server.auth.providers.azure import AzureProvider

        from .oauth_storage import build_client_storage

        # required_scopes are UNPREFIXED names of scopes THIS app exposes;
        # AzureProvider prefixes each with identifier_uri (→ api://<client>/<scope>)
        # so the minted token's audience is our own API — exactly what the token
        # verifier checks. Default to "access", the scope on the registration.
        # (Graph scopes like User.Read would instead go in additional_authorize_
        # scopes, in full form; we don't need Graph here.)
        scopes = config.MCP_SCOPES or ["access"]
        server = AzureProvider(
            client_id=config.AZURE_CLIENT_ID,
            client_secret=config.AZURE_CLIENT_SECRET,
            tenant_id=config.AZURE_TENANT_ID,
            required_scopes=scopes,
            base_url=config.MCP_PUBLIC_URL,
            identifier_uri=config.AZURE_API_AUDIENCE or None,
            # Shared, persistent OAuth state (encrypted, in our Postgres) so the
            # connect flow works across replicas and survives deploys — the
            # default per-process file store does neither. See oauth_storage.py.
            client_storage=build_client_storage(config.AZURE_CLIENT_SECRET),
        )
        # MultiAuth tries the AzureProvider first (browser-issued tokens), then
        # the delegated verifier (Entra tokens presented directly). Users
        # authenticate exactly as before; the OAuth ceremony + metadata still
        # come from AzureProvider. required_scopes=[] here because each
        # component enforces its own scope requirement.
        delegated_verifier = _build_delegated_verifier()
        if delegated_verifier is None:
            return server
        log.info("MCP auth: direct delegated-token path enabled")
        return MultiAuth(server=server, verifiers=[delegated_verifier], required_scopes=[])
    except Exception as exc:  # noqa: BLE001
        log.error("MCP auth: failed to build MCP auth provider (%s) — /mcp open", exc)
        return None


def _mcp_token_claims() -> Optional[dict]:
    """Claims of the current MCP request's validated access token, or None when
    there is no token (dev/open mode, or called outside a request)."""
    try:
        from fastmcp.server.dependencies import get_access_token

        token = get_access_token()
    except Exception:  # noqa: BLE001 — no auth context / not in a request
        return None
    return getattr(token, "claims", None) if token else None


def mcp_identity() -> Optional[dict]:
    """Resolve the caller of an MCP tool to an identity dict {oid, upn, name}.

    Mirrors `resolve_identity` for the REST side: reads the validated token's
    claims (Entra's, or the ones `BetterAuthTokenVerifier` builds), falling
    back to the dev stub user when AUTH_MODE=dev so /mcp works locally without
    OAuth. Returns None only when auth is required but no
    valid token is present.
    """
    claims = _mcp_token_claims()
    if claims is None:
        if config.AUTH_MODE == "dev":
            return dict(config.DEV_USER)
        return None
    oid = claims.get("oid") or claims.get("sub")
    upn = (
        claims.get("preferred_username")
        or claims.get("upn")
        or claims.get("email")
        or ""
    )
    name = claims.get("name") or ""
    if not oid:
        log.warning("MCP token has no oid/sub claim")
        return None
    return {"oid": oid, "upn": upn, "name": name}


def mcp_client_name() -> Optional[str]:
    """The connected MCP client's self-reported name (Claude, openai-mcp, …) from
    the initialize handshake, for write attribution. None outside a session."""
    try:
        from fastmcp.server.dependencies import get_context

        ctx = get_context()
    except Exception:  # noqa: BLE001
        return None
    session = getattr(ctx, "session", None)
    params = getattr(session, "client_params", None) if session else None
    info = getattr(params, "clientInfo", None) if params else None
    name = getattr(info, "name", None) if info else None
    return name or None
