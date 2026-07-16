"""Process-global state — a lazily-created asyncpg pool.

The pool is created on first use inside the running event loop (uvicorn's),
which avoids binding it to the wrong loop. Good enough and simple; a FastMCP
lifespan can replace this later if needed.
"""
from __future__ import annotations

import asyncio
from typing import Optional

import asyncpg

from . import config

_pool: Optional[asyncpg.Pool] = None
_lock = asyncio.Lock()


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        async with _lock:
            if _pool is None:
                _pool = await asyncpg.create_pool(
                    config.DATABASE_URL, min_size=1, max_size=10
                )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
