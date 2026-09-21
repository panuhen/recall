"""Authentication / identity resolution.

Two paths:
- REST API (from the web BFF): the BFF validates the MSAL session and forwards
  X-User-* headers over the trusted internal network. `resolve_identity` reads
  them (falling back to the dev stub user when AUTH_MODE=dev).
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
"""
from __future__ import annotations

import logging
from typing import Optional

import jwt
from fastmcp.server.auth.providers.jwt import JWTVerifier
from jwt import PyJWKClient
from starlette.requests import Request

from . import config

log = logging.getLogger("recall.auth")


def resolve_identity(request: Request) -> Optional[dict]:
    """Resolve the caller from BFF-injected headers (or the dev stub user)."""
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


def build_mcp_auth():
    """Build the FastMCP auth provider for /mcp, or None to leave it open.

    Returns an ``AzureProvider`` (Entra OAuth via an OAuthProxy: one registered
    confidential app, browser consent, standard client discovery) when running
    in "entra" mode with the client secret configured, wrapped in a
    ``MultiAuth`` that also accepts delegated Entra tokens presented directly
    (see :func:`_build_delegated_verifier`). Otherwise returns None so /mcp is
    unauthenticated — the local-dev default, where `mcp_identity` serves the
    stub user. Never raises: a misconfiguration logs a warning and degrades to
    open rather than crashing the whole backend (REST included).
    """
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

    Mirrors `resolve_identity` for the REST side: reads the validated Entra
    token's claims, falling back to the dev stub user when AUTH_MODE=dev so /mcp
    works locally without OAuth. Returns None only when auth is required but no
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
