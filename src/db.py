"""Database schema helpers run at backend startup.

``run_migrations`` applies the Alembic migrations (raw SQL, no ORM; Alembic uses
SQLAlchemy + psycopg2 synchronously). ``reconcile_embedding_dim`` then fits the
``notes.embedding`` column to ``EMBEDDING_DIM`` (asyncpg, like the runtime).
Only the backend calls these; the worker never does.
"""
from __future__ import annotations

import asyncio
import logging

import asyncpg
from alembic import command
from alembic.config import Config

from . import config

log = logging.getLogger("recall.db")

# Held (transaction-scoped) while the embedding column is being altered, so two
# backend replicas booting together don't both rebuild it. Arbitrary constant:
# ASCII "recall" + 0x01.
_EMBEDDING_DIM_LOCK = 0x726563616C6C01

# Must match migration 002's index exactly (name, opclass, params).
_EMBEDDING_INDEX_SQL = (
    "CREATE INDEX idx_notes_embedding ON notes "
    "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
)

_TYPMOD_SQL = (
    "SELECT atttypmod FROM pg_attribute "
    "WHERE attrelid = 'notes'::regclass AND attname = 'embedding' AND NOT attisdropped"
)


def run_migrations() -> None:
    """Apply all pending Alembic migrations (idempotent)."""
    log.info("Applying database migrations (alembic upgrade head)...")
    cfg = Config("alembic.ini")
    cfg.attributes["configure_logger"] = False  # keep the app's logging (see env.py)
    command.upgrade(cfg, "head")
    log.info("Migrations applied.")


async def reconcile_embedding_dim(conn: asyncpg.Connection, dim: int) -> bool:
    """Make ``notes.embedding`` a ``vector(dim)``. Returns True if it changed.

    No-op (one catalog read, no lock) when the column already has that size.
    Otherwise, in one transaction under an advisory lock: drop the HNSW index,
    retype the column with every embedding set to NULL, clear ``embedded_hash``,
    and recreate the index. The startup backfill then re-embeds every note.
    The size is re-read after the lock is taken, so a replica that waited on
    another one's change finds nothing left to do.
    """
    dim = config.parse_embedding_dim(str(dim))  # also guards the DDL literal below
    if await conn.fetchval(_TYPMOD_SQL) == dim:
        log.info("embedding column is vector(%d), matching EMBEDDING_DIM; no change", dim)
        return False
    async with conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", _EMBEDDING_DIM_LOCK)
        current = await conn.fetchval(_TYPMOD_SQL)
        if current == dim:
            return False
        was = str(current) if current and current > 0 else "unsized"
        log.warning(
            "embedding dimension changed %s → %d; all notes will be re-embedded", was, dim
        )
        await conn.execute("DROP INDEX IF EXISTS idx_notes_embedding")
        await conn.execute(
            f"ALTER TABLE notes ALTER COLUMN embedding TYPE vector({dim}) "
            f"USING NULL::vector({dim})"
        )
        await conn.execute("UPDATE notes SET embedded_hash = NULL")
        await conn.execute(_EMBEDDING_INDEX_SQL)
    return True


def reconcile_embedding_dim_at_startup() -> bool:
    """Synchronous entry point for ``server.main``: run the reconcile on a
    throwaway connection before the server's event loop starts."""

    async def _run() -> bool:
        conn = await asyncpg.connect(config.DATABASE_URL)
        try:
            return await reconcile_embedding_dim(conn, config.EMBEDDING_DIM)
        finally:
            await conn.close()

    return asyncio.run(_run())
