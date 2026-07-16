"""favorites: starred shortcuts to notes/folders/workspaces

Per-user, manually ordered shortcuts shown in a Favorites section at the top of
the sidebar. `item_id` is polymorphic across notes/folders/projects, so there's
no FK — `list_favorites` resolves each row and drops any that are gone or no
longer visible to the user.

Revision ID: 006
Revises: 005
Create Date: 2026-07-12
"""
from __future__ import annotations

from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE favorites (
            user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            item_type  TEXT NOT NULL CHECK (item_type IN ('note','folder','project')),
            item_id    UUID NOT NULL,
            position   DOUBLE PRECISION NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, item_type, item_id)
        )
        """
    )
    op.execute("CREATE INDEX idx_favorites_user ON favorites (user_id, position)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS favorites CASCADE")
