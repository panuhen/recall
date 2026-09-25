"""Embedding provider (azure / openai-compatible), config validation, the
content hash, the startup backfill, and the embedding-dimension reconcile.

HTTP is mocked with ``httpx.MockTransport`` (no network). The reconcile tests
retype ``notes.embedding`` in recall_test and always restore it afterwards.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import asyncpg
import httpx
import pytest
import pytest_asyncio

from src import config, state, tasks
from src import embeddings_provider as ep
from src.db import reconcile_embedding_dim

# Bound at collection time: conftest's autouse fixture later replaces the
# module attribute with a stub for every test.
from src.embeddings_provider import embed_query as _real_embed_query

DIM = 4


def _vec(i: int, dim: int = DIM) -> list[float]:
    v = [0.0] * dim
    v[i % dim] = 1.0
    return v


@pytest.fixture
def mock_http(monkeypatch):
    """Route every httpx.AsyncClient through a MockTransport. Returns the list
    of captured requests; set ``.respond`` to change the reply."""

    class Recorder(list):
        # Default reply: one valid DIM-sized vector per input, in order.
        def respond(self, request: httpx.Request) -> httpx.Response:
            inputs = json.loads(request.content)["input"]
            return httpx.Response(200, json={"data": [
                {"index": i, "embedding": _vec(i)} for i in range(len(inputs))
            ]})

    calls = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return calls.respond(request)

    real = httpx.AsyncClient

    def client(*args, **kwargs):
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return calls


@pytest.fixture
def openai_cfg(monkeypatch):
    """openai provider pointed at a self-hosted server with no key."""
    monkeypatch.setattr(config, "EMBEDDING_PROVIDER", "openai")
    monkeypatch.setattr(config, "EMBEDDING_BASE_URL", "http://ollama:11434/v1/")
    monkeypatch.setattr(config, "EMBEDDING_API_KEY", "")
    monkeypatch.setattr(config, "EMBEDDING_MODEL", "bge-m3")
    monkeypatch.setattr(config, "EMBEDDING_DIM", DIM)
    monkeypatch.setattr(config, "EMBEDDING_SEND_DIMENSIONS", "auto")
    return monkeypatch


@pytest.fixture
def azure_cfg(monkeypatch):
    monkeypatch.setattr(config, "EMBEDDING_PROVIDER", "azure")
    monkeypatch.setattr(
        config, "AZURE_OPENAI_EMBEDDING_ENDPOINT",
        "https://res.cognitiveservices.azure.com/openai/deployments/te3l/embeddings"
        "?api-version=2024-02-01",
    )
    monkeypatch.setattr(config, "AZURE_OPENAI_API_KEY", "azure-key")
    monkeypatch.setattr(config, "AZURE_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    monkeypatch.setattr(config, "EMBEDDING_DIM", DIM)
    # Set to show they are ignored by the azure provider.
    monkeypatch.setattr(config, "EMBEDDING_API_KEY", "openai-key")
    monkeypatch.setattr(config, "EMBEDDING_SEND_DIMENSIONS", "false")
    return monkeypatch


def _body(req: httpx.Request) -> dict:
    return json.loads(req.content)


# ── openai provider: request shape ──────────────────────────


async def test_openai_request_shape_self_hosted(openai_cfg, mock_http):
    out = await ep.embed_texts(["a", "b"])
    assert out == [_vec(0), _vec(1)]
    [req] = mock_http
    assert req.method == "POST"
    # Trailing slash on the base URL is tolerated (no "//embeddings").
    assert str(req.url) == "http://ollama:11434/v1/embeddings"
    assert _body(req) == {"input": ["a", "b"], "model": "bge-m3"}  # auto ⇒ no dimensions
    assert "authorization" not in req.headers
    assert "api-key" not in req.headers


async def test_openai_default_base_url(openai_cfg, mock_http):
    openai_cfg.setattr(config, "EMBEDDING_BASE_URL", "https://api.openai.com/v1")
    await ep.embed_texts(["a"])
    assert str(mock_http[0].url) == "https://api.openai.com/v1/embeddings"


async def test_openai_bearer_only_when_key_set(openai_cfg, mock_http):
    openai_cfg.setattr(config, "EMBEDDING_API_KEY", "sk-test")
    await ep.embed_texts(["a"])
    assert mock_http[0].headers["authorization"] == "Bearer sk-test"


@pytest.mark.parametrize(
    ("mode", "model", "sent"),
    [
        ("auto", "text-embedding-3-large", True),
        ("auto", "text-embedding-3-small", True),
        ("auto", "openai/text-embedding-3-large", True),  # LiteLLM-style prefix
        ("auto", "text-embedding-ada-002", False),
        ("auto", "nomic-embed-text", False),
        ("true", "bge-m3", True),
        ("false", "text-embedding-3-large", False),
    ],
)
async def test_openai_dimensions_param(openai_cfg, mock_http, mode, model, sent):
    openai_cfg.setattr(config, "EMBEDDING_SEND_DIMENSIONS", mode)
    openai_cfg.setattr(config, "EMBEDDING_MODEL", model)
    await ep.embed_texts(["a"])
    body = _body(mock_http[0])
    assert body["model"] == model
    if sent:
        assert body["dimensions"] == DIM
    else:
        assert "dimensions" not in body


async def test_response_reordered_by_index(openai_cfg, mock_http):
    mock_http.respond = lambda req: httpx.Response(200, json={"data": [
        {"index": 2, "embedding": _vec(2)},
        {"index": 0, "embedding": _vec(0)},
        {"index": 1, "embedding": _vec(1)},
    ]})
    assert await ep.embed_texts(["a", "b", "c"]) == [_vec(0), _vec(1), _vec(2)]


async def test_batches_preserve_order(openai_cfg, mock_http):
    texts = [f"t{i}" for i in range(ep._BATCH + 3)]
    out = await ep.embed_texts(texts)
    assert len(mock_http) == 2
    assert len(out) == len(texts)
    assert out[ep._BATCH] == _vec(0)  # second batch restarts at index 0


# ── error paths ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(401, json={"error": "unauthorized"}),
        httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0, 0.0]}]}),  # dims
        httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.0] * DIM}]}),  # zero
        # Python's json accepts NaN; some servers emit it.
        httpx.Response(200, text='{"data": [{"index": 0, "embedding": [NaN, 1, 0, 0]}]}'),
        httpx.Response(200, json={"data": []}),  # count mismatch
        httpx.Response(200, json={"nope": 1}),  # malformed
        httpx.Response(200, text="not json"),
    ],
    ids=["500", "401", "wrong-dim", "zero", "nan", "missing", "no-data", "not-json"],
)
async def test_bad_responses_raise_embedding_error(openai_cfg, mock_http, response):
    mock_http.respond = lambda req: response
    with pytest.raises(ep.EmbeddingError):
        await ep.embed_texts(["a"])


async def test_transport_error_raises_embedding_error(openai_cfg, mock_http):
    def fail(req):
        raise httpx.ConnectError("refused", request=req)

    mock_http.respond = fail
    with pytest.raises(ep.EmbeddingError, match="request failed"):
        await ep.embed_texts(["a"])


async def test_non_200_message_names_provider(openai_cfg, mock_http):
    mock_http.respond = lambda req: httpx.Response(503, text="overloaded")
    with pytest.raises(ep.EmbeddingError, match="openai 503: overloaded"):
        await ep.embed_texts(["a"])


async def test_unknown_provider_at_call_time(monkeypatch, mock_http):
    monkeypatch.setattr(config, "EMBEDDING_PROVIDER", "cohere")
    with pytest.raises(ep.EmbeddingError, match="unsupported EMBEDDING_PROVIDER"):
        await ep.embed_texts(["a"])
    assert mock_http == []


# ── azure provider: unchanged ───────────────────────────────


async def test_azure_request_unchanged(azure_cfg, mock_http):
    assert await ep.embed_texts(["a"]) == [_vec(0)]
    [req] = mock_http
    assert str(req.url) == config.AZURE_OPENAI_EMBEDDING_ENDPOINT
    assert req.headers["api-key"] == "azure-key"
    assert "authorization" not in req.headers
    # Always sends dimensions, never a model (the deployment URL picks it).
    assert _body(req) == {"input": ["a"], "dimensions": DIM}


async def test_azure_unconfigured_raises(azure_cfg, mock_http):
    azure_cfg.setattr(config, "AZURE_OPENAI_API_KEY", "")
    with pytest.raises(ep.EmbeddingError, match="not configured"):
        await ep.embed_texts(["a"])
    assert mock_http == []


async def test_azure_error_message(azure_cfg, mock_http):
    mock_http.respond = lambda req: httpx.Response(429, text="slow down")
    with pytest.raises(ep.EmbeddingError, match="azure 429: slow down"):
        await ep.embed_texts(["a"])


async def test_embed_query_returns_none_on_failure(openai_cfg, mock_http):
    mock_http.respond = lambda req: httpx.Response(500, text="down")
    assert await _real_embed_query("hello") is None
    mock_http.respond = type(mock_http).respond.__get__(mock_http)
    assert await _real_embed_query("hello") == _vec(0)


# ── config validation ───────────────────────────────────────


@pytest.mark.parametrize("raw", ["1", "768", "1536", " 1024 ", "2000"])
def test_dim_in_range(raw):
    assert config.parse_embedding_dim(raw) == int(raw)


@pytest.mark.parametrize("raw", ["0", "-5", "2001", "3072", "abc", ""])
def test_dim_out_of_range(raw):
    with pytest.raises(ValueError, match="EMBEDDING_DIM"):
        config.parse_embedding_dim(raw)


def test_provider_parsing():
    assert config.parse_embedding_provider("") == "azure"
    assert config.parse_embedding_provider(" OpenAI ") == "openai"
    with pytest.raises(ValueError, match="unknown EMBEDDING_PROVIDER='ollama'"):
        config.parse_embedding_provider("ollama")


def test_send_dimensions_parsing():
    assert config.parse_send_dimensions("") == "auto"
    assert config.parse_send_dimensions("TRUE") == "true"
    assert config.parse_send_dimensions("0") == "false"
    with pytest.raises(ValueError, match="EMBEDDING_SEND_DIMENSIONS"):
        config.parse_send_dimensions("sometimes")


_REPO = Path(__file__).resolve().parents[1]


def _import_config(**env: str) -> subprocess.CompletedProcess:
    """Import src.config in a fresh interpreter with the given embedding env
    (the rest cleared, so a local .env can't leak in via load_dotenv)."""
    keys = ("EMBEDDING_PROVIDER", "EMBEDDING_DIM", "AZURE_OPENAI_EMBEDDING_DIM",
            "EMBEDDING_SEND_DIMENSIONS")
    full = {**os.environ, **{k: "" for k in keys}, **env}
    return subprocess.run(
        [sys.executable, "-c", "from src import config; print(config.EMBEDDING_DIM)"],
        cwd=_REPO, env=full, capture_output=True, text=True, timeout=30,
    )


@pytest.mark.parametrize(
    ("env", "dim"),
    [
        ({}, "1536"),
        ({"AZURE_OPENAI_EMBEDDING_DIM": "300"}, "300"),
        ({"EMBEDDING_DIM": "768", "AZURE_OPENAI_EMBEDDING_DIM": "1536"}, "768"),
    ],
    ids=["default", "azure-fallback", "generic-wins"],
)
def test_dim_env_precedence(env, dim):
    r = _import_config(**env)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == dim


@pytest.mark.parametrize(
    ("env", "msg"),
    [
        ({"EMBEDDING_DIM": "3072"}, "EMBEDDING_DIM must be between 1 and 2000"),
        ({"AZURE_OPENAI_EMBEDDING_DIM": "0"}, "EMBEDDING_DIM must be between 1 and 2000"),
        ({"EMBEDDING_PROVIDER": "ollama"}, "unknown EMBEDDING_PROVIDER"),
    ],
)
def test_bad_config_fails_at_import(env, msg):
    r = _import_config(**env)
    assert r.returncode != 0
    assert msg in r.stderr


# ── content hash ────────────────────────────────────────────


def test_azure_hash_format_unchanged(monkeypatch):
    """Upgrading must not invalidate existing Azure vectors."""
    monkeypatch.setattr(config, "EMBEDDING_PROVIDER", "azure")
    monkeypatch.setattr(config, "AZURE_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    monkeypatch.setattr(config, "EMBEDDING_DIM", 1536)
    expected = hashlib.sha256(b"text-embedding-3-large|1536|hello").hexdigest()
    assert ep.content_hash("hello") == expected


def test_hash_changes_with_model_and_dim(openai_cfg):
    base = ep.content_hash("hello")
    openai_cfg.setattr(config, "EMBEDDING_MODEL", "nomic-embed-text")
    other_model = ep.content_hash("hello")
    openai_cfg.setattr(config, "EMBEDDING_DIM", 8)
    other_dim = ep.content_hash("hello")
    assert len({base, other_model, other_dim}) == 3
    # The openai provider hashes EMBEDDING_MODEL, not the azure model name.
    openai_cfg.setattr(config, "AZURE_OPENAI_EMBEDDING_MODEL", "something-else")
    assert ep.content_hash("hello") == other_dim


def test_hash_follows_provider_switch(openai_cfg):
    openai_cfg.setattr(config, "AZURE_OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    openai_on_bge = ep.content_hash("hello")
    openai_cfg.setattr(config, "EMBEDDING_PROVIDER", "azure")
    assert ep.content_hash("hello") != openai_on_bge


# ── startup backfill: missing and stale vectors ─────────────


async def test_backfill_enqueues_missing_and_stale(
    monkeypatch, make_user, make_project, make_note
):
    queued: list[str] = []

    async def record(note_id: str) -> None:
        queued.append(note_id)

    async def noop() -> None:
        return None

    monkeypatch.setattr(tasks, "_ensure_open", noop)
    monkeypatch.setattr(tasks, "enqueue_embed", record)

    user = await make_user()
    proj = await make_project(user)
    missing = await make_note(proj, title="Missing", body="no vector yet")
    fresh = await make_note(proj, title="Fresh", body="embedded with current model")
    stale = await make_note(proj, title="Stale", body="embedded with an old model")
    archived = await make_note(proj, title="Gone", body="archived, no vector")

    pool = await state.get_pool()
    row = await pool.fetchrow(
        "SELECT title, body, type, tags FROM notes WHERE id = $1::uuid", fresh.id
    )
    fresh_hash = ep.content_hash(
        ep.build_embed_text(row["title"], row["body"], list(row["tags"]), row["type"])
    )
    vec = ep.to_pgvector(_vec(0, 1536))
    await pool.execute(
        "UPDATE notes SET embedding = $2::vector, embedded_hash = $3 WHERE id = $1::uuid",
        fresh.id, vec, fresh_hash,
    )
    await pool.execute(
        "UPDATE notes SET embedding = $2::vector, embedded_hash = 'old-model' "
        "WHERE id = $1::uuid",
        stale.id, vec,
    )
    await pool.execute("UPDATE notes SET archived_at = now() WHERE id = $1::uuid", archived.id)

    assert await tasks.enqueue_backfill() == 2
    assert set(queued) == {missing.id, stale.id}

    # Switching the model makes every embedded note stale.
    queued.clear()
    monkeypatch.setattr(config, "AZURE_OPENAI_EMBEDDING_MODEL", "some-other-model")
    monkeypatch.setattr(config, "EMBEDDING_MODEL", "some-other-model")
    await tasks.enqueue_backfill()
    assert set(queued) == {missing.id, fresh.id, stale.id}


# ── startup dimension reconcile ─────────────────────────────


async def _column_type(conn: asyncpg.Connection) -> str:
    return await conn.fetchval(
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = 'notes'::regclass AND attname = 'embedding'"
    )


async def _index_def(conn: asyncpg.Connection) -> str | None:
    return await conn.fetchval(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_notes_embedding'"
    )


@pytest_asyncio.fixture
async def embedding_conn(db_pool):
    """A dedicated connection for reconcile tests. Always puts the column back
    to the configured size, so later tests see the normal schema."""
    conn = await asyncpg.connect(config.DATABASE_URL)
    try:
        yield conn
    finally:
        try:
            await reconcile_embedding_dim(conn, config.EMBEDDING_DIM)
        finally:
            await conn.close()


async def test_reconcile_noop_when_dims_match(embedding_conn):
    before = await _index_def(embedding_conn)
    assert await _column_type(embedding_conn) == f"vector({config.EMBEDDING_DIM})"
    assert await reconcile_embedding_dim(embedding_conn, config.EMBEDDING_DIM) is False
    assert await _index_def(embedding_conn) == before


async def test_reconcile_changes_dim(embedding_conn, make_user, make_project, make_note):
    user = await make_user()
    proj = await make_project(user)
    note = await make_note(proj, title="Vec", body="has a 1536 vector")
    pool = await state.get_pool()
    await pool.execute(
        "UPDATE notes SET embedding = $2::vector, embedded_hash = 'h' WHERE id = $1::uuid",
        note.id, ep.to_pgvector(_vec(0, 1536)),
    )
    index_before = await _index_def(embedding_conn)
    assert "hnsw" in index_before

    assert await reconcile_embedding_dim(embedding_conn, 768) is True

    assert await _column_type(embedding_conn) == "vector(768)"
    typmod = await embedding_conn.fetchval(
        "SELECT atttypmod FROM pg_attribute "
        "WHERE attrelid = 'notes'::regclass AND attname = 'embedding'"
    )
    assert typmod == 768
    row = await embedding_conn.fetchrow(
        "SELECT embedding, embedded_hash FROM notes WHERE id = $1::uuid", note.id
    )
    assert row["embedding"] is None
    assert row["embedded_hash"] is None
    # Same index as migration 002: name, method, opclass and params.
    assert await _index_def(embedding_conn) == index_before
    assert "USING hnsw (embedding vector_cosine_ops)" in index_before
    assert "m='16'" in index_before and "ef_construction='64'" in index_before

    # The column now takes 768-dim vectors (and rejects 1536).
    await embedding_conn.execute(
        "UPDATE notes SET embedding = $2::vector, embedded_hash = 'h768' "
        "WHERE id = $1::uuid",
        note.id, ep.to_pgvector(_vec(1, 768)),
    )
    with pytest.raises(asyncpg.PostgresError, match="expected 768 dimensions"):
        await embedding_conn.execute(
            "UPDATE notes SET embedding = $2::vector WHERE id = $1::uuid",
            note.id, ep.to_pgvector(_vec(1, 1536)),
        )

    # Second run at the same size: no-op, the new vector survives.
    assert await reconcile_embedding_dim(embedding_conn, 768) is False
    row = await embedding_conn.fetchrow(
        "SELECT embedding IS NOT NULL AS has_vec, embedded_hash FROM notes "
        "WHERE id = $1::uuid", note.id,
    )
    assert row["has_vec"] and row["embedded_hash"] == "h768"


async def test_reconcile_concurrent_replicas(embedding_conn):
    """Two backends booting at once: exactly one retypes the column."""
    other = await asyncpg.connect(config.DATABASE_URL)
    try:
        results = await asyncio.gather(
            reconcile_embedding_dim(embedding_conn, 768),
            reconcile_embedding_dim(other, 768),
        )
    finally:
        await other.close()
    assert sorted(results) == [False, True]
    assert await _column_type(embedding_conn) == "vector(768)"
    assert await _index_def(embedding_conn) is not None


async def test_reconcile_rejects_bad_dim(embedding_conn):
    with pytest.raises(ValueError, match="EMBEDDING_DIM"):
        await reconcile_embedding_dim(embedding_conn, 4096)
    assert await _column_type(embedding_conn) == f"vector({config.EMBEDDING_DIM})"
