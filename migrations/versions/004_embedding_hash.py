"""note embedding idempotency hash

Records the content hash of the text that produced a note's current embedding,
so the async ``embed_note`` worker can skip re-embedding when nothing that
affects the vector has changed. Nullable; NULL means "never embedded".

Revision ID: 004
Revises: 003
Create Date: 2026-07-11
"""
from __future__ import annotations

from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE notes ADD COLUMN IF NOT EXISTS embedded_hash TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE notes DROP COLUMN IF EXISTS embedded_hash")
