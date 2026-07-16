"""org-wide workspace visibility: projects.org_access + project_pins

Lets an owner make a workspace readable by anyone in the org ("general access",
Google-Drive style). `org_access` is the baseline grant (only 'viewer' for now;
editor/owner stay explicit per-person). `project_pins` records which org-visible
workspaces each user keeps in their sidebar (DB-backed so pins follow the user
across devices).

Revision ID: 005
Revises: 004
Create Date: 2026-07-12
"""
from __future__ import annotations

from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE projects ADD COLUMN org_access TEXT NOT NULL DEFAULT 'none' "
        "CHECK (org_access IN ('none','viewer'))"
    )
    op.execute(
        """
        CREATE TABLE project_pins (
            user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, project_id)
        )
        """
    )
    # Fast lookup of org-visible workspaces (the search + browse scope).
    op.execute(
        "CREATE INDEX idx_projects_org_access ON projects (org_access) "
        "WHERE org_access <> 'none'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_projects_org_access")
    op.execute("DROP TABLE IF EXISTS project_pins CASCADE")
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS org_access")
