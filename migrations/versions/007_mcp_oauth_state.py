"""mcp_oauth_kv: shared, persistent MCP OAuth proxy state

FastMCP's OAuthProxy stores all its OAuth state (proxied client registrations,
in-flight transactions, authorization codes, refresh-token metadata, upstream
token sets) in a pluggable key-value backend. We point it at this table (see
src/oauth_storage.py) so the state is shared across replicas and survives
deploys — the default per-process file store breaks both.

The DDL matches what py-key-value-aio's PostgreSQLStore would auto-create, so
the store's `auto_create` remains a harmless IF-NOT-EXISTS no-op; Alembic owns
the schema. Values are Fernet-encrypted JSON envelopes, keyed by (collection,
key) where collections are FastMCP's state namespaces (mcp-oauth-proxy-clients,
mcp-oauth-transactions, ...).

Revision ID: 007
Revises: 006
Create Date: 2026-07-13
"""
from __future__ import annotations

from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_oauth_kv (
            collection TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      JSONB NOT NULL,
            ttl        DOUBLE PRECISION,
            created_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            PRIMARY KEY (collection, key)
        )
        """
    )
    # Partial index for TTL sweeps (see tasks.purge_expired_oauth_state).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_oauth_kv_expires_at "
        "ON mcp_oauth_kv (expires_at) WHERE expires_at IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS mcp_oauth_kv CASCADE")
