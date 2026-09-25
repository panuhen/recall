"""external identity: users.entra_oid (UUID) → external_id (TEXT) + idp

recall can now run against Better Auth as well as Entra. Better Auth user ids
are opaque strings, not UUIDs, so the stable identity column becomes TEXT and
is renamed to say what it is: the id the identity provider knows the user by.
`idp` records which provider that is ('entra', 'betterauth' or 'dev'). Existing
rows keep their Entra oid, cast to its canonical text form, and are tagged
'entra'.

Revision ID: 009
Revises: 008
Create Date: 2026-09-24
"""
from __future__ import annotations

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users RENAME COLUMN entra_oid TO external_id")
    op.execute("ALTER TABLE users ALTER COLUMN external_id TYPE TEXT USING external_id::text")
    op.execute(
        "ALTER TABLE users RENAME CONSTRAINT users_entra_oid_key TO users_external_id_key"
    )
    op.execute(
        """
        ALTER TABLE users ADD COLUMN idp TEXT NOT NULL DEFAULT 'entra'
            CHECK (idp IN ('entra', 'betterauth', 'dev'))
        """
    )


def downgrade() -> None:
    # Only reversible while every external_id is still a UUID (i.e. before any
    # Better Auth user signed in); the cast fails loudly otherwise.
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS idp")
    op.execute(
        "ALTER TABLE users RENAME CONSTRAINT users_external_id_key TO users_entra_oid_key"
    )
    op.execute("ALTER TABLE users ALTER COLUMN external_id TYPE UUID USING external_id::uuid")
    op.execute("ALTER TABLE users RENAME COLUMN external_id TO entra_oid")
