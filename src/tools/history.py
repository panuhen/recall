"""Version-history tools: list revisions, read one, restore one."""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ._base import (
    FORBIDDEN,
    NOT_FOUND,
    UNAUTH,
    WRITE_ROLES,
    note_and_role,
    note_dict,
    resolve_user,
)

_READ = {"readOnlyHint": True, "openWorldHint": False}
_WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="List note revisions", annotations=_READ)
    async def list_revisions(note_id: str) -> dict:
        """Version history for a note (newest first): id, trigger, label, author,
        timestamp. Bodies are fetched with `read_revision`."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        return {"revisions": await data.list_revisions(note.id)}

    @mcp.tool(title="Read a note revision", annotations=_READ)
    async def read_revision(note_id: str, revision_id: str) -> dict:
        """Fetch the full body of one past revision of a note."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        rev = await data.get_revision(note.id, revision_id)
        if rev is None:
            return NOT_FOUND
        return rev

    @mcp.tool(title="Restore a note revision", annotations=_WRITE)
    async def restore_revision(note_id: str, revision_id: str) -> dict:
        """Roll a note's body back to a past revision (editor+). The current body
        is snapshotted first, so the restore is itself reversible."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        restored = await data.restore_revision(note.id, revision_id, user.id)
        if restored is None:
            return NOT_FOUND
        return note_dict(restored)
