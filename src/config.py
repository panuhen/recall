"""Environment configuration for the recall backend."""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

# ── Database ────────────────────────────────────────────────
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://recall:recall@localhost:54324/recall"
)

# ── Server ──────────────────────────────────────────────────
MCP_HOST = os.environ.get("MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.environ.get("MCP_PORT", "8765"))

# Host allowlist for the MCP HTTP transport (DNS-rebinding protection stays on).
# Includes the internal compose service name so the web BFF can reach it.
# In prod, add the public MCP FQDN via MCP_ALLOWED_HOSTS.
MCP_ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get(
        "MCP_ALLOWED_HOSTS",
        "localhost:*,127.0.0.1:*,[::1]:*,backend,backend:*",
    ).split(",")
    if h.strip()
]

# ── Auth ────────────────────────────────────────────────────
# "dev"        → inject a fixed dev user, no token validation (LOCAL ONLY)
# "entra"      → validate Entra JWTs (issuer + audience + tid pinned to our tenant)
# "betterauth" → the web app runs Better Auth (Google sign-in) and is the OAuth
#                authorization server for /mcp; this backend is a resource
#                server that validates its opaque access tokens (see auth.py)
AUTH_MODE = os.environ.get("AUTH_MODE", "dev").lower()

DEV_USER = {
    "oid": os.environ.get("DEV_USER_OID", "00000000-0000-0000-0000-000000000001"),
    "upn": os.environ.get("DEV_USER_UPN", "dev@example.com"),
    "name": os.environ.get("DEV_USER_NAME", "Dev User"),
}

AZURE_TENANT_ID = os.environ.get("AZURE_TENANT_ID", "")
AZURE_CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "")
AZURE_API_AUDIENCE = os.environ.get("AZURE_API_AUDIENCE", "")

# ── MCP OAuth (Entra) ───────────────────────────────────────
# The /mcp endpoint authenticates AI assistants (Claude, Copilot) with a proper
# browser OAuth flow via FastMCP's AzureProvider, which wraps an OAuthProxy: we
# register ONE confidential app in Entra and FastMCP proxies dynamic client
# registration to it, so MCP clients get the standard "open browser → consent →
# connected" flow. This proxying is required because Entra offers no RFC 7591
# DCR endpoint at all (no registration_endpoint in its OIDC discovery), and our
# tenant additionally blocks users from creating app registrations
# (authorizationPolicy allowedToCreateApps=false; verified 2026-07-13). No PATs.
#
# The proxy's OAuth state (registered clients, transactions, tokens) lives in
# Postgres (mcp_oauth_kv, encrypted — see oauth_storage.py) so the flow works
# across replicas and survives deploys.
#
# Requires (in "entra" auth mode): a client secret on the app registration, the
# redirect URI  {MCP_PUBLIC_URL}/auth/callback  registered on it, and an exposed
# API scope (or a delegated Graph scope) listed in MCP_SCOPES. When any of these
# are missing the provider is left unconfigured and /mcp serves tools only in dev
# mode — the server still boots (degraded), it doesn't crash.
AZURE_CLIENT_SECRET = os.environ.get("AZURE_CLIENT_SECRET", "")

# Public base URL the MCP server is reached at (scheme + host, no trailing slash).
# Used for OAuth redirect + protected-resource metadata, so it must match what
# the client hits. Prod: the public MCP FQDN. Dev: the host-published backend.
MCP_PUBLIC_URL = os.environ.get("MCP_PUBLIC_URL", "http://localhost:8004").rstrip("/")

# Delegated scopes the access token must carry. Default to the app's own exposed
# scope (identifier-uri-based); override per environment.
MCP_SCOPES = [
    s.strip()
    for s in os.environ.get("MCP_SCOPES", "").split(",")
    if s.strip()
]

# ── Better Auth (AUTH_MODE=betterauth) ──────────────────────
# Public web origin, which is also Better Auth's OAuth issuer. Kept VERBATIM (no
# trailing-slash normalisation): the protected-resource metadata must advertise
# it byte-identical to the issuer in Better Auth's own authorization-server
# metadata, or strict clients (Claude.ai) refuse to register.
BETTER_AUTH_URL = os.environ.get("BETTER_AUTH_URL", "")

# Public origin of the web app (scheme + host, no trailing slash). MCP tools use
# it to return shareable `url`s for notes and workspaces. Falls back to
# BETTER_AUTH_URL, which is the web origin in betterauth mode; when neither is
# set, `url` is null.
APP_URL = (os.environ.get("APP_URL", "") or BETTER_AUTH_URL).rstrip("/")
# Where this backend reaches the web app for token validation. Inside compose
# that's the service name (http://web:3000), not the public origin.
BETTER_AUTH_INTERNAL_URL = (
    os.environ.get("BETTER_AUTH_INTERNAL_URL", "") or BETTER_AUTH_URL
).rstrip("/")
# Seconds a get-session verdict (valid or rejected) is cached per token.
BETTER_AUTH_TOKEN_CACHE_TTL = int(os.environ.get("BETTER_AUTH_TOKEN_CACHE_TTL", "60"))

# ── Trash / retention ───────────────────────────────────────
# Deletes are soft (archived_at). Items stay in Trash and are restorable until
# either the user purges them or auto-purge removes them. TRASH_RETENTION_DAYS
# <= 0 disables auto-purge entirely (keep forever / manual purge only, the
# default); a positive value hard-deletes items archived longer ago than that,
# on the schedule below (run by the procrastinate worker's periodic deferrer).
TRASH_RETENTION_DAYS = int(os.environ.get("TRASH_RETENTION_DAYS", "0"))
TRASH_PURGE_CRON = os.environ.get("TRASH_PURGE_CRON", "0 4 * * *")  # daily 04:00

# ── Embeddings ──────────────────────────────────────────────
# EMBEDDING_PROVIDER picks the HTTP API the worker (and the search endpoint, for
# the query vector) calls. There is no in-process model; a local model runs as
# its own server (e.g. Ollama) and is reached through the "openai" provider.
#   "azure"  → an Azure OpenAI embeddings deployment (AZURE_OPENAI_* below)
#   "openai" → any OpenAI-compatible POST {EMBEDDING_BASE_URL}/embeddings:
#              OpenAI itself, Ollama's /v1, vLLM, HF TEI, LiteLLM, …
EMBEDDING_PROVIDERS = ("azure", "openai")
_EMBEDDING_PROVIDER_RAW = os.environ.get("EMBEDDING_PROVIDER", "")

# azure: the endpoint is a full deployment URL (…/deployments/<model>/embeddings
# ?api-version=…). The model name only feeds the content hash (the deployment
# decides the actual model).
AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_EMBEDDING_ENDPOINT = os.environ.get("AZURE_OPENAI_EMBEDDING_ENDPOINT", "")
AZURE_OPENAI_EMBEDDING_MODEL = os.environ.get(
    "AZURE_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large"
)

# openai: base URL without the /embeddings suffix (a trailing slash is fine).
# The key is optional: when empty no Authorization header is sent, which is what
# most self-hosted servers expect.
EMBEDDING_BASE_URL = (
    os.environ.get("EMBEDDING_BASE_URL", "") or "https://api.openai.com/v1"
).rstrip("/")
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "") or "text-embedding-3-large"

# Vector size, for every provider. It must match what the model returns, and it
# sets the notes.embedding column type: on startup the backend ALTERs the column
# to vector(EMBEDDING_DIM) if it differs, and every note is re-embedded (see
# db.reconcile_embedding_dim). 1..2000, because pgvector's HNSW index is capped
# at 2000 dims for `vector`. AZURE_OPENAI_EMBEDDING_DIM is the older name, still
# read as a fallback. text-embedding-3-large is requested at 1536 (Matryoshka).
EMBEDDING_DIM_MAX = 2000
_EMBEDDING_DIM_RAW = (
    os.environ.get("EMBEDDING_DIM", "")
    or os.environ.get("AZURE_OPENAI_EMBEDDING_DIM", "")
    or "1536"
)

# Whether the openai provider sends the `dimensions` request param:
#   "auto"  → only for OpenAI text-embedding-3* models, which support shortening
#             (Matryoshka); self-hosted models often reject or ignore the param
#   "true"  → always     "false" → never (the model must natively return EMBEDDING_DIM)
# The azure provider always sends it.
_EMBEDDING_SEND_DIMENSIONS_RAW = os.environ.get("EMBEDDING_SEND_DIMENSIONS", "")


def parse_embedding_provider(raw: str) -> str:
    """Normalise EMBEDDING_PROVIDER; ``ValueError`` if it names no provider."""
    provider = (raw or "azure").strip().lower()
    if provider not in EMBEDDING_PROVIDERS:
        raise ValueError(
            f"unknown EMBEDDING_PROVIDER={raw!r}; "
            f"expected one of: {', '.join(EMBEDDING_PROVIDERS)}"
        )
    return provider


def parse_embedding_dim(raw: str) -> int:
    """Parse and range-check EMBEDDING_DIM; ``ValueError`` if out of range."""
    try:
        dim = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"EMBEDDING_DIM must be an integer, got {raw!r}") from None
    if not 1 <= dim <= EMBEDDING_DIM_MAX:
        raise ValueError(
            f"EMBEDDING_DIM must be between 1 and {EMBEDDING_DIM_MAX} "
            f"(pgvector's HNSW limit for `vector`), got {dim}"
        )
    return dim


def parse_send_dimensions(raw: str) -> str:
    """Normalise EMBEDDING_SEND_DIMENSIONS to "auto" / "true" / "false"."""
    value = (raw or "auto").strip().lower()
    if value == "auto":
        return value
    if value in ("true", "1", "yes", "on"):
        return "true"
    if value in ("false", "0", "no", "off"):
        return "false"
    raise ValueError(f"EMBEDDING_SEND_DIMENSIONS must be auto, true or false, got {raw!r}")


# Validated at import, so a bad value stops the backend and the worker at
# startup instead of failing every embed later.
EMBEDDING_PROVIDER = parse_embedding_provider(_EMBEDDING_PROVIDER_RAW)
EMBEDDING_DIM = parse_embedding_dim(_EMBEDDING_DIM_RAW)
EMBEDDING_SEND_DIMENSIONS = parse_send_dimensions(_EMBEDDING_SEND_DIMENSIONS_RAW)
