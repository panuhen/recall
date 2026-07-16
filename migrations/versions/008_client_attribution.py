"""client attribution: record which MCP client (AI assistant) made a write

`notes.created_via` / `notes.updated_via` and `note_revisions.client` hold the
MCP client's self-reported name from the initialize handshake (e.g. 'Claude',
'openai-mcp', 'Codex'). NULL means the write came through the web UI (BFF) —
or predates this migration. Provenance/display only, not a security control:
the name is self-reported by the client.

Revision ID: 008
Revises: 007
Create Date: 2026-07-14
"""
from __future__ import annotations

from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE notes ADD COLUMN created_via TEXT")
    op.execute("ALTER TABLE notes ADD COLUMN updated_via TEXT")
    op.execute("ALTER TABLE note_revisions ADD COLUMN client TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE note_revisions DROP COLUMN IF EXISTS client")
    op.execute("ALTER TABLE notes DROP COLUMN IF EXISTS updated_via")
    op.execute("ALTER TABLE notes DROP COLUMN IF EXISTS created_via")
