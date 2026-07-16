"""Test harness for the recall backend.

Hermetic, and hard-isolated from the dev database:

* All tests run against a SEPARATE database ``recall_test`` (never the ``recall``
  dev DB, which holds real notes). The URL is derived from ``DATABASE_URL`` by
  swapping only the database name, so it points at the same Postgres server.
* External side-effects are monkeypatched to no-ops: the embedding job enqueue
  (``data.enqueue_embed``) and the Azure query-embedding call (``embed_query``).
  No Azure, no procrastinate worker.
* Each test gets truncated tables (hard-guarded to ``recall_test``) and a fresh
  asyncpg pool bound to that test's event loop.

Everything is function-scoped so a test and its autouse fixtures share the one
event loop pytest-asyncio creates per test — the app's process-global pool is
recreated per test rather than shared across loops, which keeps asyncpg happy
without any custom event-loop juggling.
"""
from __future__ import annotations

import os

# ── Point the whole process at the test DB BEFORE importing any src module ──
# config.DATABASE_URL is read from the environment at import time, and the pool
# / alembic read it later; setting it here (before the src imports below) makes
# every consumer target recall_test.


def _swap_db(url: str, name: str) -> str:
    """Replace only the database-name path segment of a Postgres URL."""
    base, _, _old = url.rpartition("/")
    return f"{base}/{name}"


TEST_DB_NAME = "recall_test"
_ORIG_DB_URL = os.environ.get(
    "DATABASE_URL", "postgresql://recall:recall@postgres:5432/recall"
)
TEST_DB_URL = _swap_db(_ORIG_DB_URL, TEST_DB_NAME)
# Maintenance connection (to CREATE DATABASE recall_test) — the always-present
# "postgres" database on the same server.
MAINT_DB_URL = _swap_db(_ORIG_DB_URL, "postgres")

os.environ["DATABASE_URL"] = TEST_DB_URL
# Dev auth so resolve_user()/mcp_identity() yield the stub user if ever reached.
os.environ.setdefault("AUTH_MODE", "dev")

import asyncio  # noqa: E402
import uuid  # noqa: E402

import asyncpg  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from src import config, data, state  # noqa: E402
from src.db import run_migrations  # noqa: E402

# Belt-and-suspenders: if config was imported before we set the env var, force
# the module attribute to the test URL too.
config.DATABASE_URL = TEST_DB_URL

# Truncate order is irrelevant with CASCADE, but list every app table so a test
# never leaks rows into the next one.
_TABLES = (
    "favorites",
    "project_pins",
    "note_revisions",
    "note_links",
    "notes",
    "folders",
    "invitations",
    "project_members",
    "projects",
    "users",
)


async def _noop_async(*args, **kwargs):
    """Stand-in for enqueue_embed (side-effect dropped) and embed_query (returns
    None ⇒ search degrades to keyword-only). Individual tests override the
    embed_query binding they care about to inject a vector."""
    return None


async def _ensure_test_db() -> None:
    conn = await asyncpg.connect(MAINT_DB_URL)
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", TEST_DB_NAME
        )
        if not exists:
            await conn.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session", autouse=True)
def _database():
    """Once per session: create recall_test if absent and migrate it to head.
    Both steps are synchronous (asyncpg via a throwaway loop; alembic via
    psycopg2), so they don't touch the per-test event loops."""
    asyncio.run(_ensure_test_db())
    run_migrations()  # alembic upgrade head against TEST_DB_URL (env set above)
    yield


@pytest.fixture(autouse=True)
def _no_external(monkeypatch):
    """Drop every external side-effect. enqueue_embed/mcp_client_name/embed_query
    are bound as local names in the modules that use them, so patch them there."""
    monkeypatch.setattr("src.data.enqueue_embed", _noop_async)
    monkeypatch.setattr("src.embeddings_provider.embed_query", _noop_async)
    # tools bind embed_query at import; patch those names too (best-effort).
    monkeypatch.setattr("src.tools.notes.embed_query", _noop_async, raising=False)
    monkeypatch.setattr("src.tools.search.embed_query", _noop_async, raising=False)
    # Default: web path (no MCP client) ⇒ *_via columns stay null.
    monkeypatch.setattr("src.data.mcp_client_name", lambda: None)


@pytest_asyncio.fixture(autouse=True)
async def db_pool(_database):
    """Per test: a fresh pool bound to this test's loop + truncated tables.
    Hard-guards that we're connected to recall_test before truncating."""
    await state.close_pool()
    pool = await state.get_pool()
    dbname = await pool.fetchval("SELECT current_database()")
    assert dbname == TEST_DB_NAME, (
        f"refusing to truncate {dbname!r}; tests must run against {TEST_DB_NAME!r}"
    )
    await pool.execute(
        "TRUNCATE " + ", ".join(_TABLES) + " RESTART IDENTITY CASCADE"
    )
    yield pool
    await state.close_pool()


# ── Factories ───────────────────────────────────────────────


@pytest_asyncio.fixture
async def make_user():
    async def _make(*, oid: str | None = None, upn: str | None = None,
                    name: str = "Test User") -> data.User:
        oid = oid or str(uuid.uuid4())
        upn = upn or f"{uuid.uuid4().hex[:12]}@example.com"
        return await data.upsert_user(oid, upn, name)

    return _make


@pytest_asyncio.fixture
async def make_project():
    async def _make(owner: data.User, name: str = "Workspace") -> data.Project:
        # create_project also inserts the owner's 'owner' membership row.
        return await data.create_project(owner.id, name)

    return _make


@pytest_asyncio.fixture
async def add_member():
    async def _add(project: data.Project, user: data.User, role: str) -> None:
        pool = await state.get_pool()
        await pool.execute(
            "INSERT INTO project_members (project_id, user_id, role) "
            "VALUES ($1::uuid, $2::uuid, $3) "
            "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            project.id, user.id, role,
        )

    return _add


@pytest_asyncio.fixture
async def make_note():
    async def _make(project: data.Project, *, title: str = "Note", body: str = "",
                    author: data.User | None = None,
                    folder_id: str | None = None) -> data.Note:
        uid = author.id if author else project.owner_id
        return await data.create_note(project.id, title, body, uid, folder_id)

    return _make


@pytest_asyncio.fixture
async def tool_fn():
    """Resolve an MCP tool to its underlying async function (``FunctionTool.fn``)
    so tool-layer logic (auth gating, the dup nudge) can be exercised directly.
    Tools close over their module globals, so tests monkeypatch e.g.
    ``src.tools.notes.resolve_user`` / ``embed_query`` to steer them."""
    from fastmcp import FastMCP

    from src.tools import notes as notes_tools
    from src.tools import search as search_tools

    mcp = FastMCP("test")
    notes_tools.register(mcp)
    search_tools.register(mcp)

    async def _get(name: str):
        return (await mcp.get_tool(name)).fn

    return _get
