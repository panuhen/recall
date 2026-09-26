"""Workspace health tools: what needs attention (including what's overdue for
review), and marking a note reviewed.

Health is computed from what recall stores: edit dates, links, `status`, and
each note's own `owner:`, `review_every:` and `reviewed:` frontmatter. The only
write is `mark_reviewed`.
"""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ..links import note_url, with_note_urls
from ._base import FORBIDDEN, NOT_FOUND, UNAUTH, WRITE_ROLES, note_and_role, resolve_user

_READ = {"readOnlyHint": True, "openWorldHint": False}
_WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}

_LISTS = ("overdue", "not_edited", "old_drafts", "orphans", "broken_links", "owner_left")


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="Workspace health", annotations=_READ)
    async def workspace_health(project_id: str) -> dict:
        """Notes in a workspace that need attention, each with a `url`:

        - `overdue`: past their own `review_every` (e.g. `review_every: 6mo`)
        - `not_edited`: not edited or reviewed in `stale_after_months`
        - `old_drafts`: `status: draft` and untouched as long
        - `orphans`: no link in or out
        - `broken_links`: `[[links]]` to a missing or trashed note
        - `owner_left`: `owner:` names someone who's no longer a member

        `counts` has the totals (lists are capped). Read-only.

        To review overdue notes: check each one's content against reality. If
        it's still right, call `mark_reviewed`; if not, fix it with
        `update_note` (or propose the fix to the user first). Each entry has
        its `type`, so a routine can take just the runbooks, say.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        health = await data.workspace_health(project_id)
        for key in _LISTS:
            with_note_urls(health[key])
        return health

    @mcp.tool(title="Mark a note reviewed", annotations=_WRITE)
    async def mark_reviewed(note_id: str) -> dict:
        """Record that a note is still correct: sets `reviewed:` to today in its
        frontmatter and changes nothing else (editor+). Only call it after
        actually checking the content. Errors: `conflict` (the note changed
        meanwhile, so read it and retry), `frontmatter_invalid` (fix the YAML
        first)."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        try:
            updated = await data.mark_reviewed(note.id, user.id)
        except data.StaleUpdate:
            return {"error": "conflict"}
        except data.ReviewError as e:
            return {"error": e.code}
        if updated is None:
            return NOT_FOUND
        health = await data.note_health(updated)
        return {
            "id": updated.id,
            "title": updated.title,
            "reviewed": updated.metadata.get("reviewed"),
            "review": health["review"],
            "updated_at": updated.updated_at,
            "url": note_url(updated.id),
        }


async def guide_for_agent(project_id: str) -> dict | None:
    """The workspace guide as an assistant should see it: the full body (the
    prose is the instructions) plus parsed conventions and any problems."""
    guide = await data.get_guide(project_id)
    if guide is None:
        return None
    return {
        "id": guide["id"],
        "title": guide["title"],
        "url": note_url(guide["id"]),
        "body": guide["body"],
        "conventions": guide["conventions"],
        "problems": guide["problems"],
    }


async def write_feedback(note: "data.Note") -> dict:
    """Extra keys for create_note/update_note responses. Whenever the workspace
    has a guide, `workspace_guide` names it with its conventions, so an
    assistant that wrote without calling `list_tree` still learns it exists;
    `convention_hints` lists where this note departs from it (only when any)."""
    health = await data.note_health(note)
    extra: dict = {}
    if health["guide_id"]:
        guide = await data.get_guide(note.project_id)
        if guide is not None:
            extra["workspace_guide"] = {
                "id": guide["id"],
                "title": guide["title"],
                "url": note_url(guide["id"]),
                "conventions": guide["conventions"],
            }
    if health["hints"]:
        extra["convention_hints"] = health["hints"]
    return extra


__all__ = ["register", "guide_for_agent", "write_feedback"]
