"""Better Auth identity mode (AUTH_MODE=betterauth).

Covers migration 009 (entra_oid → external_id on existing rows), string user
ids through upsert_user, the opaque-token verifier against a mocked
get-session (httpx.MockTransport — no web app), mode selection in
build_mcp_auth, the issuer-exact protected-resource metadata, and the
/api/users/search people picker.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from fastmcp import FastMCP
from fastmcp.server.auth import RemoteAuthProvider
from starlette.requests import Request

from src import auth, config, data, state

ISSUER = "http://localhost:3000"
INTERNAL = "http://web:3000"
SESSION_URL = f"{INTERNAL}/api/auth/mcp/get-session"


# ── Migration 009 ───────────────────────────────────────────


async def test_migration_keeps_existing_entra_rows(db_pool):
    """Downgrade to 008, insert an Entra-era row, upgrade: the oid survives as
    text, tagged idp='entra', and the CHECK rejects unknown providers."""
    await state.close_pool()  # the ALTERs invalidate asyncpg's cached plans
    cfg = Config("alembic.ini")
    oid = str(uuid.uuid4())
    command.downgrade(cfg, "008")
    try:
        conn = await asyncpg.connect(config.DATABASE_URL)
        try:
            await conn.execute(
                "INSERT INTO users (entra_oid, upn, display_name) VALUES ($1::uuid, $2, $3)",
                oid, "old@example.com", "Old User",
            )
        finally:
            await conn.close()
    finally:
        command.upgrade(cfg, "head")

    conn = await asyncpg.connect(config.DATABASE_URL)
    try:
        row = await conn.fetchrow("SELECT external_id, idp FROM users WHERE upn = $1",
                                  "old@example.com")
        assert row["external_id"] == oid
        assert row["idp"] == "entra"
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute("UPDATE users SET idp = 'github' WHERE upn = 'old@example.com'")
    finally:
        await conn.close()

    user = await data.get_user_by_external_id(oid)
    assert user is not None and user.upn == "old@example.com" and user.idp == "entra"


# ── upsert_user with string ids ─────────────────────────────


async def test_upsert_accepts_better_auth_string_id():
    ba_id = "Xk2bq9LwT0aZ7pYdRr1sVn"  # Better Auth ids are opaque strings
    user = await data.upsert_user(ba_id, "ada@example.com", "Ada", idp="betterauth")
    assert user.external_id == ba_id and user.idp == "betterauth"

    again = await data.upsert_user(ba_id, "ada@example.com", "Ada Lovelace", idp="betterauth")
    assert again.id == user.id and again.display_name == "Ada Lovelace"

    found = await data.get_user_by_external_id(ba_id)
    assert found is not None and found.id == user.id


async def test_upsert_reconciles_on_upn_and_defaults_idp(monkeypatch):
    # Dev-stub row first (idp defaults to the running AUTH_MODE)…
    dev = await data.upsert_user(str(uuid.uuid4()), "grace@example.com", "Grace")
    assert dev.idp == "dev"
    # …then the real Better Auth identity with the same email claims it.
    monkeypatch.setattr(config, "AUTH_MODE", "betterauth")
    real = await data.upsert_user("ba_grace", "grace@example.com", "Grace Hopper")
    assert real.id == dev.id
    assert real.external_id == "ba_grace" and real.idp == "betterauth"


# ── BetterAuthTokenVerifier ─────────────────────────────────


@pytest_asyncio.fixture
async def ba_user_table(db_pool):
    """A minimal ba_user (Better Auth creates the real one from the web app)."""
    await db_pool.execute(
        "CREATE TABLE IF NOT EXISTS ba_user (id TEXT PRIMARY KEY, email TEXT NOT NULL, "
        "name TEXT NOT NULL)"
    )
    await db_pool.execute("TRUNCATE ba_user")
    await db_pool.execute(
        "INSERT INTO ba_user (id, email, name) VALUES ('u1', 'ada@example.com', 'Ada')"
    )
    yield
    await db_pool.execute("DROP TABLE IF EXISTS ba_user")


class FakeBetterAuth:
    """Stands in for GET /api/auth/mcp/get-session; counts calls."""

    def __init__(self, status: int = 200, body=None):
        self.status = status
        self.body = body
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        # json.dumps, not json=: httpx sends no body at all for json=None, and
        # Better Auth's rejection is a literal `null`.
        return httpx.Response(
            self.status, content=json.dumps(self.body),
            headers={"content-type": "application/json"},
        )

    def verifier(self, **kw) -> auth.BetterAuthTokenVerifier:
        return auth.BetterAuthTokenVerifier(
            internal_url=INTERNAL, transport=httpx.MockTransport(self), **kw
        )


def _session(user_id: str = "u1", expires_in: int = 3600) -> dict:
    exp = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    return {
        "accessToken": "tok",
        "userId": user_id,
        "clientId": "client-1",
        "scopes": "openid profile email offline_access",
        "accessTokenExpiresAt": exp.isoformat().replace("+00:00", "Z"),
    }


async def test_valid_token_yields_identity_claims(ba_user_table, monkeypatch):
    ba = FakeBetterAuth(body=_session())
    token = await ba.verifier().verify_token("tok")

    assert token is not None
    req = ba.calls[0]
    assert str(req.url) == SESSION_URL
    assert req.headers["authorization"] == "Bearer tok"
    assert token.client_id == "client-1"
    assert "offline_access" in token.scopes
    assert token.expires_at is not None

    # mcp_identity reads these claims exactly as it reads Entra's.
    monkeypatch.setattr(auth, "_mcp_token_claims", lambda: token.claims)
    assert auth.mcp_identity() == {"oid": "u1", "upn": "ada@example.com", "name": "Ada"}


async def test_positive_cache_skips_second_call(ba_user_table):
    ba = FakeBetterAuth(body=_session())
    v = ba.verifier()
    assert await v.verify_token("tok") is not None
    assert await v.verify_token("tok") is not None
    assert len(ba.calls) == 1


async def test_json_null_is_rejected_and_cached():
    ba = FakeBetterAuth(body=None)  # Better Auth's "invalid token" is 200 + null
    v = ba.verifier()
    assert await v.verify_token("bad") is None
    assert await v.verify_token("bad") is None
    assert len(ba.calls) == 1


async def test_401_is_rejected_and_cached():
    ba = FakeBetterAuth(status=401)
    v = ba.verifier()
    assert await v.verify_token("bad") is None
    assert await v.verify_token("bad") is None
    assert len(ba.calls) == 1


async def test_5xx_is_not_cached():
    ba = FakeBetterAuth(status=503)
    v = ba.verifier()
    assert await v.verify_token("tok") is None
    assert await v.verify_token("tok") is None
    assert len(ba.calls) == 2


async def test_network_error_is_not_cached():
    calls = []

    def boom(request):
        calls.append(request)
        raise httpx.ConnectError("down")

    v = auth.BetterAuthTokenVerifier(internal_url=INTERNAL, transport=httpx.MockTransport(boom))
    assert await v.verify_token("tok") is None
    assert await v.verify_token("tok") is None
    assert len(calls) == 2


async def test_negative_cache_is_bounded():
    ba = FakeBetterAuth(body=None)
    v = ba.verifier(cache_max=3)
    for i in range(10):
        assert await v.verify_token(f"bad-{i}") is None
        assert len(v._rejected) <= 3


async def test_unknown_user_is_rejected_uncached(ba_user_table):
    ba = FakeBetterAuth(body=_session(user_id="ghost"))
    v = ba.verifier()
    assert await v.verify_token("tok") is None
    assert await v.verify_token("tok") is None
    assert len(ba.calls) == 2


# ── build_mcp_auth mode selection + metadata ────────────────


def _betterauth_env(monkeypatch, url: str = ISSUER, internal: str = INTERNAL):
    monkeypatch.setattr(config, "AUTH_MODE", "betterauth")
    monkeypatch.setattr(config, "BETTER_AUTH_URL", url)
    monkeypatch.setattr(config, "BETTER_AUTH_INTERNAL_URL", internal)
    monkeypatch.setattr(config, "MCP_PUBLIC_URL", "http://localhost:8004")


def test_build_mcp_auth_betterauth(monkeypatch):
    _betterauth_env(monkeypatch)
    provider = auth.build_mcp_auth()
    assert isinstance(provider, auth.BetterAuthProvider)
    assert isinstance(provider, RemoteAuthProvider)
    assert isinstance(provider.token_verifier, auth.BetterAuthTokenVerifier)
    assert provider.token_verifier.session_url == SESSION_URL


def test_build_mcp_auth_betterauth_without_url_is_open(monkeypatch):
    _betterauth_env(monkeypatch, url="", internal="")
    assert auth.build_mcp_auth() is None


def test_build_mcp_auth_entra_unconfigured_is_open(monkeypatch):
    monkeypatch.setattr(config, "AUTH_MODE", "entra")
    monkeypatch.setattr(config, "AZURE_CLIENT_SECRET", "")
    assert auth.build_mcp_auth() is None


async def test_protected_resource_metadata_issuer_is_exact(monkeypatch):
    _betterauth_env(monkeypatch)
    app = FastMCP("t", auth=auth.build_mcp_auth()).http_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8004") as c:
        meta = await c.get("/.well-known/oauth-protected-resource/mcp")
        assert meta.status_code == 200
        body = meta.json()
        # Byte-identical to BETTER_AUTH_URL: no trailing slash appended.
        assert body["authorization_servers"] == [ISSUER]
        assert '"http://localhost:3000"' in meta.text
        assert body["resource"] == "http://localhost:8004/mcp"

        # The 401 points clients at exactly that metadata document.
        unauth = await c.post("/mcp", json={})
        assert unauth.status_code == 401
        assert (
            'resource_metadata="http://localhost:8004/.well-known/oauth-protected-resource/mcp"'
            in unauth.headers["www-authenticate"]
        )


# ── /api/users/search ───────────────────────────────────────


def _request(q: str, headers: dict | None = None) -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/users/search",
        "query_string": f"q={q}".encode(),
        "headers": [(k.encode(), v.encode()) for k, v in (headers or {}).items()],
    })


_CALLER = {"x-user-id": "ba_me", "x-user-upn": "me@example.com", "x-user-name": "Me"}


async def test_users_search_requires_identity(monkeypatch):
    from src import server

    monkeypatch.setattr(config, "AUTH_MODE", "betterauth")
    resp = await server.api_users_search(_request("ada"))
    assert resp.status_code == 401


async def test_users_search_matches_name_and_upn(monkeypatch, make_user):
    from src import server

    monkeypatch.setattr(config, "AUTH_MODE", "betterauth")
    await make_user(oid="ba_ada", upn="ada@example.com", name="Ada Lovelace")
    await make_user(oid="ba_bob", upn="bob@example.com", name="Bob")
    await make_user(oid="ba_pct", upn="p100@example.com", name="Percent")

    resp = await server.api_users_search(_request("love", _CALLER))
    assert json.loads(resp.body) == {
        "results": [{"oid": "ba_ada", "upn": "ada@example.com", "name": "Ada Lovelace"}]
    }

    resp = await server.api_users_search(_request("bob%40", _CALLER))
    assert [r["oid"] for r in json.loads(resp.body)["results"]] == ["ba_bob"]

    # LIKE wildcards match literally, not as patterns.
    resp = await server.api_users_search(_request("%25%25", _CALLER))
    assert json.loads(resp.body)["results"] == []

    # Below the 2-character minimum: nothing, not everyone.
    resp = await server.api_users_search(_request("a", _CALLER))
    assert json.loads(resp.body)["results"] == []
