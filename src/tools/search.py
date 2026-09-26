"""Retrieval tools: hybrid search, structured query, semantic link candidates,
unlinked mentions."""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ..embeddings_provider import embed_query
from ..links import with_note_urls
from ._base import NOT_FOUND, UNAUTH, WRITE_ROLES, note_and_role, resolve_user

_READ = {"readOnlyHint": True, "openWorldHint": False}


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="Search notes", annotations=_READ)
    async def search(query: str, project_id: str | None = None, limit: int = 20) -> dict:
        """Hybrid keyword + semantic search across every note you can access.

        Fuses full-text and vector similarity (RRF) with a light recency tie-break.
        Returns ranked notes with a snippet: the passage around the matched
        words for a keyword hit, the note's opening for a meaning-only hit.
        Check the snippet before calling `read_note` for a full body. For an
        exact string (a name, error code, path or quote), use `grep`.

        Args:
            query: What to look for. Natural language works (it's embedded).
            project_id: Optional — scope to a single workspace.
            limit: Max results, 1–50 (default 20).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        q = (query or "").strip()
        if not q:
            return {"results": [], "semantic": False}
        if project_id and await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        limit = max(1, min(int(limit or 20), 50))
        qvec = await embed_query(q)
        results = await data.search_notes(user.id, q, qvec, project_id, limit)
        return {"results": with_note_urls(results), "semantic": qvec is not None}

    @mcp.tool(title="Find exact text", annotations=_READ)
    async def grep(text: str, project_id: str | None = None, limit: int = 20) -> dict:
        """Find notes containing `text` exactly: case-insensitive and literal
        (not a regex, no stemming), across every note you can access. Use it
        for names, error codes, file paths, URLs and quotes; use `search` for
        questions about meaning.

        Each result has an `excerpt` of the matching lines in `grep -n -C1`
        format (`12:` a matching line, `11-` context, `--` between groups; line
        numbers count from the top of the note, frontmatter included), up to 5
        matching lines per note, plus `match_count` for the whole note and
        `title_match`. Most recently edited notes first. Often the excerpt is
        enough; call `read_note` only when you need more.

        Args:
            text: The exact text to find, at least 2 characters.
            project_id: Optional — scope to a single workspace.
            limit: Max notes, 1–50 (default 20).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        t = (text or "").strip()
        if len(t) < 2:
            return {"error": "text_too_short", "results": []}
        if project_id and await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        limit = max(1, min(int(limit or 20), 50))
        results = await data.grep_notes(user.id, t[:200], project_id, limit)
        return {"results": with_note_urls(results)}

    @mcp.tool(title="Query notes by metadata", annotations=_READ)
    async def query_notes(
        project_id: str | None = None,
        type: str | None = None,
        tags: list[str] | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> dict:
        """List notes by structured metadata (no relevance ranking).

        All filters AND together. Use this for "all open tasks", "everything
        tagged X and Y", etc. For meaning-based lookup use `search` instead.

        Args:
            project_id: Optional workspace scope.
            type: Frontmatter `type` (e.g. note, task, meeting).
            tags: Match notes carrying ALL of these tags.
            status: Frontmatter `status` (e.g. open, done).
            limit: Max results, 1–200 (default 50).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if project_id and await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        limit = max(1, min(int(limit or 50), 200))
        notes = await data.query_notes(
            user.id, project_id=project_id, type=type, tags=tags,
            status=status, limit=limit,
        )
        return {"notes": with_note_urls(notes)}

    @mcp.tool(title="Suggest links for a note", annotations=_READ)
    async def suggest_links(note_id: str, limit: int = 8) -> dict:
        """Semantically nearest notes to this one, in the same workspace — link
        candidates to propose. Excludes the note itself and notes it already
        links to. Empty until the note has been embedded. Pair with `link_notes`.

        Args:
            note_id: The note to find neighbors for.
            limit: Max candidates, 1–25 (default 8).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        limit = max(1, min(int(limit or 8), 25))
        return {"candidates": with_note_urls(await data.suggest_links(note_id, limit))}

    @mcp.tool(title="Find unlinked mentions of a note", annotations=_READ)
    async def unlinked_mentions(note_id: str, limit: int = 20) -> dict:
        """Notes in the same workspace that mention this note's title (or one of
        its frontmatter `aliases`) in plain text but don't link to it yet — the
        "someone wrote its name but forgot the [[wikilink]]" list.

        Matching is case-insensitive on whole words/phrases ("worker" doesn't
        match "coworkers"), with no stemming. Mentions inside code, existing
        wikilinks, markdown links/URLs and frontmatter don't count; terms under
        3 characters and generic one-word titles (note, todo, draft, …) are
        skipped. Trashed notes and notes already linking here are excluded.

        Each mention: `id`/`title`/`url` of the mentioning note, `term` (the
        title or alias matched), `match` (the text as written), and `snippet`
        (context around the first mention). `can_edit` says whether you may
        convert them with `link_mention`.

        Args:
            note_id: The note being mentioned.
            limit: Max mentioning notes, 1–50 (default 20).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        limit = max(1, min(int(limit or 20), 50))
        mentions = with_note_urls(await data.get_unlinked_mentions(note.id, limit))
        return {"mentions": mentions, "can_edit": role in WRITE_ROLES}
