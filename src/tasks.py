"""Procrastinate app and background tasks.

Postgres-backed job queue — the jobs table lives in the same database, so there
is no separate broker. Used for async embedding: on note create/update we
``defer`` an ``embed_note`` job; the worker process embeds via the configured
provider (``src/embeddings_provider.py``) and writes the vector, with retries
and idempotency.

The web/backend process only *defers* jobs (it opens the connector lazily on
first enqueue). The separate ``worker`` container runs the jobs.
"""
from __future__ import annotations

import asyncio
import logging

from procrastinate import App, PsycopgConnector, RetryStrategy
from procrastinate.exceptions import AlreadyEnqueued

from . import config
from .embeddings_provider import build_embed_text, content_hash, embed_texts, to_pgvector
from .state import get_pool

log = logging.getLogger("recall.tasks")

procrastinate_app = App(
    connector=PsycopgConnector(conninfo=config.DATABASE_URL),
    import_paths=["src.tasks"],
)

# The connector is opened once per process, on first enqueue. The worker opens
# its own via the `procrastinate worker` CLI, so this only matters in the
# backend/API process that defers jobs.
_opened = False
_open_lock = asyncio.Lock()


async def _ensure_open() -> None:
    global _opened
    if _opened:
        return
    async with _open_lock:
        if not _opened:
            await procrastinate_app.open_async()
            _opened = True


async def close_procrastinate() -> None:
    global _opened
    if _opened:
        await procrastinate_app.close_async()
        _opened = False


@procrastinate_app.task(queue="default", name="ping")
async def ping_task(message: str = "pong") -> None:
    """No-op task used to verify the worker is processing jobs."""
    log.info("ping task ran: %s", message)


@procrastinate_app.periodic(cron=config.TRASH_PURGE_CRON)
@procrastinate_app.task(queue="maintenance", name="purge_archived")
async def purge_archived(timestamp: int) -> None:
    """Auto-purge: hard-delete Trash items archived longer ago than
    TRASH_RETENTION_DAYS. Disabled (no-op) when retention is <= 0 — the default —
    so nothing is ever auto-deleted unless the env var opts in. Scheduled by the
    worker's periodic deferrer at TRASH_PURGE_CRON; `timestamp` is the tick time
    procrastinate uses to dedupe runs."""
    days = config.TRASH_RETENTION_DAYS
    if days <= 0:
        return
    from . import data  # lazy: data imports this module, so avoid a cycle

    purged = await data.purge_expired(days)
    if purged:
        log.info("auto-purged %d expired trash item(s) (older than %d days)", purged, days)


@procrastinate_app.periodic(cron="45 4 * * *")
@procrastinate_app.task(queue="maintenance", name="purge_expired_oauth_state")
async def purge_expired_oauth_state(timestamp: int) -> None:
    """Sweep expired MCP OAuth state (mcp_oauth_kv). The kv store filters
    expired entries on read but never deletes them, so a daily sweep keeps dead
    transactions/codes/tokens from accumulating. `timestamp` is the tick time
    procrastinate uses to dedupe runs."""
    pool = await get_pool()
    result = await pool.execute(
        "DELETE FROM mcp_oauth_kv "
        "WHERE expires_at IS NOT NULL AND expires_at < now()"
    )
    deleted = int(result.split()[-1])  # asyncpg returns e.g. "DELETE 3"
    if deleted:
        log.info("swept %d expired MCP OAuth state row(s)", deleted)


@procrastinate_app.task(
    queue="embeddings",
    name="embed_note",
    # The provider can be briefly rate-limited/unavailable; let the queue back
    # off and retry rather than sleeping inside the task.
    retry=RetryStrategy(max_attempts=5, exponential_wait=4),
)
async def embed_note(*, note_id: str) -> None:
    """Embed a note's *current* content and store the vector.

    - Stale-safe: reads the note fresh, so rapid successive edits collapse to a
      single up-to-date vector (the queueing lock keeps ≤1 pending job/note).
    - Idempotent: skips when the content hash already matches a stored vector.
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT title, body, type, tags, embedded_hash, "
        "       embedding IS NOT NULL AS has_vec "
        "FROM notes WHERE id = $1::uuid AND archived_at IS NULL",
        note_id,
    )
    if row is None:
        return  # note deleted/archived since the job was enqueued

    text = build_embed_text(row["title"], row["body"], list(row["tags"]), row["type"])
    h = content_hash(text)
    if row["has_vec"] and row["embedded_hash"] == h:
        return  # nothing that affects the vector changed

    [vec] = await embed_texts([text])
    # Only write if no newer job has already updated the hash under us; a fresher
    # job (if the note changed again) will produce the final vector.
    await pool.execute(
        "UPDATE notes SET embedding = $2::vector, embedded_hash = $3 "
        "WHERE id = $1::uuid AND embedded_hash IS NOT DISTINCT FROM $4",
        note_id,
        to_pgvector(vec),
        h,
        row["embedded_hash"],
    )


async def enqueue_embed(note_id: str) -> None:
    """Defer a (coalesced) embedding job for a note. Safe to call on every save:
    the queueing lock keeps at most one pending job per note. Never raises — a
    queue hiccup must not break note CRUD (the startup backfill self-heals)."""
    try:
        await _ensure_open()
        await embed_note.configure(
            queueing_lock=f"embed:{note_id}"
        ).defer_async(note_id=note_id)
    except AlreadyEnqueued:
        pass  # a pending job already exists; it will embed the latest content
    except Exception as exc:  # noqa: BLE001
        log.warning("could not enqueue embed for note %s: %s", note_id, exc)


async def enqueue_backfill() -> int:
    """Enqueue embed jobs for every live note whose vector is missing or stale.

    Stale means the stored ``embedded_hash`` differs from ``content_hash`` of
    the note's current text, which also covers a model or dim switch (both are
    in the hash). Idempotent (the task skips unchanged notes). Runs on startup
    to cover the enqueue-after-commit crash window, the initial rollout, and a
    provider change; also usable as a one-off."""
    await _ensure_open()
    pool = await get_pool()
    todo: list[str] = []
    async with pool.acquire() as conn, conn.transaction():
        # A cursor keeps memory flat: every live note's body is read once.
        async for r in conn.cursor(
            "SELECT id, title, body, type, tags, embedded_hash, "
            "       embedding IS NULL AS missing "
            "FROM notes WHERE archived_at IS NULL",
            prefetch=500,
        ):
            if r["missing"] or r["embedded_hash"] != content_hash(
                build_embed_text(r["title"], r["body"], list(r["tags"]), r["type"])
            ):
                todo.append(str(r["id"]))
    for note_id in todo:
        await enqueue_embed(note_id)
    if todo:
        log.info("enqueued %d embedding backfill job(s)", len(todo))
    return len(todo)
