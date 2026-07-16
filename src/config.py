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
# "dev"   → inject a fixed dev user, no token validation (LOCAL ONLY)
# "entra" → validate Entra JWTs (issuer + audience + tid pinned to our tenant)
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

# ── Trash / retention ───────────────────────────────────────
# Deletes are soft (archived_at). Items stay in Trash and are restorable until
# either the user purges them or auto-purge removes them. TRASH_RETENTION_DAYS
# <= 0 disables auto-purge entirely (keep forever / manual purge only, the
# default); a positive value hard-deletes items archived longer ago than that,
# on the schedule below (run by the procrastinate worker's periodic deferrer).
TRASH_RETENTION_DAYS = int(os.environ.get("TRASH_RETENTION_DAYS", "0"))
TRASH_PURGE_CRON = os.environ.get("TRASH_PURGE_CRON", "0 4 * * *")  # daily 04:00

# ── Embeddings (Azure OpenAI only — no local model) ─────────
EMBEDDING_PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "azure")
AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_EMBEDDING_ENDPOINT = os.environ.get("AZURE_OPENAI_EMBEDDING_ENDPOINT", "")
AZURE_OPENAI_EMBEDDING_MODEL = os.environ.get(
    "AZURE_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large"
)
# 3-large is requested at 1536 dims (Matryoshka) to stay within pgvector's
# 2000-dim HNSW index limit; pass this as the `dimensions` param on the call.
AZURE_OPENAI_EMBEDDING_DIM = int(os.environ.get("AZURE_OPENAI_EMBEDDING_DIM", "1536"))
