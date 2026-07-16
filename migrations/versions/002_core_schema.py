"""core schema: users, projects, membership, invitations, notes, links, revisions

Revision ID: 002
Revises: 001
Create Date: 2026-07-08
"""
from __future__ import annotations

from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Identity ────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE users (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            entra_oid    UUID UNIQUE NOT NULL,
            upn          TEXT UNIQUE NOT NULL,
            display_name TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    # ── Projects (the unit of sharing) ──────────────────────
    op.execute(
        """
        CREATE TABLE projects (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name        TEXT NOT NULL,
            slug        TEXT NOT NULL,
            owner_id    UUID NOT NULL REFERENCES users(id),
            is_personal BOOLEAN NOT NULL DEFAULT FALSE,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            archived_at TIMESTAMPTZ,
            UNIQUE (owner_id, slug)
        )
        """
    )

    # ── Membership + invitations ────────────────────────────
    op.execute(
        """
        CREATE TABLE project_members (
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
            added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id, user_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE invitations (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            invited_upn TEXT NOT NULL,
            role        TEXT NOT NULL CHECK (role IN ('editor','viewer')),
            invited_by  UUID NOT NULL REFERENCES users(id),
            status      TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','accepted','revoked')),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            accepted_at TIMESTAMPTZ
        )
        """
    )

    # ── Notes (markdown documents) ──────────────────────────
    op.execute(
        """
        CREATE TABLE notes (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            slug        TEXT NOT NULL,
            body        TEXT NOT NULL DEFAULT '',
            type        TEXT,
            tags        TEXT[] NOT NULL DEFAULT '{}',
            status      TEXT,
            metadata    JSONB NOT NULL DEFAULT '{}',
            embedding   VECTOR(1536),
            search_tsv  TSVECTOR GENERATED ALWAYS AS (
                            to_tsvector('english',
                                coalesce(title, '') || ' ' || coalesce(body, ''))
                        ) STORED,
            created_by  UUID REFERENCES users(id),
            updated_by  UUID REFERENCES users(id),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            archived_at TIMESTAMPTZ,
            UNIQUE (project_id, slug)
        )
        """
    )

    # ── Links (from [[wikilinks]]) + backlinks ──────────────
    op.execute(
        """
        CREATE TABLE note_links (
            source_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            target_note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
            target_title   TEXT NOT NULL,
            link_type      TEXT NOT NULL DEFAULT 'related',
            PRIMARY KEY (source_note_id, target_title)
        )
        """
    )

    # ── Version history (snapshots) ─────────────────────────
    op.execute(
        """
        CREATE TABLE note_revisions (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            note_id    UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            body       TEXT NOT NULL,
            author_id  UUID REFERENCES users(id),
            trigger    TEXT NOT NULL,
            label      TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    # ── Indexes ─────────────────────────────────────────────
    op.execute("CREATE INDEX idx_notes_project ON notes (project_id)")
    op.execute("CREATE INDEX idx_notes_tags ON notes USING GIN (tags)")
    op.execute("CREATE INDEX idx_notes_metadata ON notes USING GIN (metadata)")
    op.execute("CREATE INDEX idx_notes_search ON notes USING GIN (search_tsv)")
    op.execute(
        "CREATE INDEX idx_notes_embedding ON notes "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )
    op.execute("CREATE INDEX idx_note_links_target ON note_links (target_note_id)")
    op.execute("CREATE INDEX idx_note_revisions_note ON note_revisions (note_id, created_at DESC)")
    op.execute("CREATE INDEX idx_members_user ON project_members (user_id)")


def downgrade() -> None:
    for table in (
        "note_revisions",
        "note_links",
        "notes",
        "invitations",
        "project_members",
        "projects",
        "users",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
