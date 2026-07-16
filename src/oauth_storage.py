"""Postgres-backed storage for the MCP OAuth proxy state.

FastMCP's OAuthProxy keeps *all* of its OAuth state — proxied client
registrations, in-flight authorization transactions, consent tokens,
authorization codes, refresh-token metadata, and upstream (Entra) token sets —
in one pluggable ``AsyncKeyValue`` backend (``client_storage``). The default is
an encrypted per-process *file* store, which breaks behind multiple replicas
(``/register`` lands on replica A, ``/token`` on replica B → ``invalid_client``)
and forgets every connected client on each deploy or restart.

This module supplies a shared, persistent backend instead: the ``mcp_oauth_kv``
table in the same Postgres the app already runs on (schema owned by Alembic,
migration 007; ``auto_create`` stays on as a harmless IF-NOT-EXISTS no-op). The
store reuses the app's asyncpg pool from ``state.get_pool()`` — no second pool,
which matters on small Azure Postgres SKUs with low connection caps.

Values are encrypted at rest with Fernet, the key derived from the Entra client
secret through the same two-step derivation FastMCP uses for its own default
store — so Entra access/refresh tokens never land in the database as plaintext.
A failed decryption (e.g. after rotating the client secret) is treated as a
cache miss, not an error: clients simply re-register and re-consent.
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any, Optional, SupportsFloat

from . import state

_TABLE_NAME = "mcp_oauth_kv"


class _LazyPostgresKV:
    """``AsyncKeyValue`` that resolves its PostgreSQLStore on first use.

    The auth provider is constructed at import time, before any event loop or
    DB pool exists, so the inner store (which needs the shared asyncpg pool)
    must be created lazily inside the running loop — same pattern as
    ``state.get_pool()`` itself.
    """

    def __init__(self) -> None:
        self._store = None
        self._lock = asyncio.Lock()

    async def _inner(self):
        if self._store is None:
            async with self._lock:
                if self._store is None:
                    from key_value.aio.stores.postgresql import PostgreSQLStore

                    self._store = PostgreSQLStore(
                        pool=await state.get_pool(),
                        table_name=_TABLE_NAME,
                        auto_create=True,
                    )
        return self._store

    # ── AsyncKeyValue protocol (delegation) ─────────────────

    async def get(
        self, key: str, *, collection: Optional[str] = None
    ) -> Optional[dict[str, Any]]:
        return await (await self._inner()).get(key, collection=collection)

    async def ttl(
        self, key: str, *, collection: Optional[str] = None
    ) -> tuple[Optional[dict[str, Any]], Optional[float]]:
        return await (await self._inner()).ttl(key, collection=collection)

    async def put(
        self,
        key: str,
        value: Mapping[str, Any],
        *,
        collection: Optional[str] = None,
        ttl: Optional[SupportsFloat] = None,
    ) -> None:
        await (await self._inner()).put(key, value, collection=collection, ttl=ttl)

    async def delete(self, key: str, *, collection: Optional[str] = None) -> bool:
        return await (await self._inner()).delete(key, collection=collection)

    async def get_many(
        self, keys: Sequence[str], *, collection: Optional[str] = None
    ) -> list[Optional[dict[str, Any]]]:
        return await (await self._inner()).get_many(keys, collection=collection)

    async def ttl_many(
        self, keys: Sequence[str], *, collection: Optional[str] = None
    ) -> list[tuple[Optional[dict[str, Any]], Optional[float]]]:
        return await (await self._inner()).ttl_many(keys, collection=collection)

    async def put_many(
        self,
        keys: Sequence[str],
        values: Sequence[Mapping[str, Any]],
        *,
        collection: Optional[str] = None,
        ttl: Optional[SupportsFloat] = None,
    ) -> None:
        await (await self._inner()).put_many(
            keys, values, collection=collection, ttl=ttl
        )

    async def delete_many(
        self, keys: Sequence[str], *, collection: Optional[str] = None
    ) -> int:
        return await (await self._inner()).delete_many(keys, collection=collection)


def build_client_storage(client_secret: str):
    """Encrypted, Postgres-backed ``client_storage`` for the OAuth proxy.

    Derives the Fernet key exactly like FastMCP's OAuthProxy derives its default
    storage key (client secret → jwt signing key → storage encryption key), so
    our storage behaves byte-for-byte like upstream's default apart from where
    the ciphertext lives.
    """
    from cryptography.fernet import Fernet
    from fastmcp.server.auth.jwt_issuer import derive_jwt_key
    from key_value.aio.wrappers.encryption import FernetEncryptionWrapper

    jwt_signing_key = derive_jwt_key(
        high_entropy_material=client_secret,
        salt="fastmcp-jwt-signing-key",
    )
    storage_encryption_key = derive_jwt_key(
        high_entropy_material=jwt_signing_key.decode(),
        salt="fastmcp-storage-encryption-key",
    )
    return FernetEncryptionWrapper(
        key_value=_LazyPostgresKV(),
        fernet=Fernet(key=storage_encryption_key),
        # Rotated secret → old rows undecryptable → treat as cache miss so
        # clients re-register instead of the whole flow erroring out.
        raise_on_decryption_error=False,
    )
