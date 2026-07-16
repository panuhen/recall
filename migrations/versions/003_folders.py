"""nested folders: folders table + notes.folder_id

Revision ID: 003
Revises: 002
Create Date: 2026-07-10
"""
from __future__ import annotations

from alembic import op

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Folders nest freely within a project (parent_id self-reference; NULL = the
    # project root). They are pure organization — sharing stays at the project
    # level, so folders carry no membership of their own. Duplicate names are
    # allowed (like Drive), so there is no slug / uniqueness constraint.
    op.execute(
        """
        CREATE TABLE folders (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            parent_id   UUID REFERENCES folders(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            created_by  UUID REFERENCES users(id),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            archived_at TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX idx_folders_project ON folders (project_id)")
    op.execute("CREATE INDEX idx_folders_parent ON folders (parent_id)")

    # A note lives in one folder (NULL = the project root). SET NULL on delete is
    # a safety net; the app soft-archives folders and their notes together.
    op.execute(
        "ALTER TABLE notes ADD COLUMN folder_id UUID "
        "REFERENCES folders(id) ON DELETE SET NULL"
    )
    op.execute("CREATE INDEX idx_notes_folder ON notes (folder_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_notes_folder")
    op.execute("ALTER TABLE notes DROP COLUMN IF EXISTS folder_id")
    op.execute("DROP TABLE IF EXISTS folders CASCADE")
