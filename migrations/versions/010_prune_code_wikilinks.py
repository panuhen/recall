"""note_links: drop edges that came from [[links]] inside code

extract_wikilinks used to index every [[link]], including ones in fenced code
blocks and inline code spans, so code examples showed up as links (and as
broken links in workspace health). It now skips code, as Obsidian does. New
saves get the right edges; this prunes the stale ones already stored, so
nobody has to re-save their notes.

Only removes edges: skipping code can drop titles but never add one. Notes
without a backtick or a tilde fence can't have code links and are skipped.

Revision ID: 010
Revises: 009
Create Date: 2026-09-26
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# The app's own parser, so the pruned set is exactly what a save would index.
from src.markdown import extract_wikilinks

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, body FROM notes WHERE body LIKE '%`%' OR body LIKE '%~~~%'")
    ).fetchall()
    for note_id, body in rows:
        keep = [t.lower() for t in extract_wikilinks(body or "")]
        conn.execute(
            sa.text(
                "DELETE FROM note_links WHERE source_note_id = :id "
                "AND NOT (lower(target_title) = ANY(:keep))"
            ),
            {"id": note_id, "keep": keep},
        )


def downgrade() -> None:
    # Data-only: the pruned edges come back when their notes are next saved
    # under the old parser.
    pass
