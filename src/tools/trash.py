"""Trash tools: list restorable items, restore, and permanently purge.

`restore`/`purge` are keyed by `item_type` ("note" | "folder" | "workspace").
Notes/folders need editor+ in their (possibly archived) workspace; restoring or
purging a whole workspace needs owner. `purge` is irreversible.
"""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ._base import FORBIDDEN, NOT_FOUND, UNAUTH, WRITE_ROLES, resolve_user

_READ = {"readOnlyHint": True, "openWorldHint": False}
_RESTORE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}
_PURGE = {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False}


async def _project_of(item_type: str, item_id: str) -> str | None:
    if item_type == "note":
        return await data.note_project(item_id)
    if item_type == "folder":
        return await data.folder_project(item_id)
    if item_type == "workspace":
        return item_id
    return None


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="List trash", annotations=_READ)
    async def list_trash() -> dict:
        """Restorable items you can act on: your archived workspaces plus the
        delete-roots (top-level trashed notes/folders) in workspaces you edit."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        return await data.list_trash(user.id)

    @mcp.tool(title="Restore from trash", annotations=_RESTORE)
    async def restore(item_type: str, item_id: str) -> dict:
        """Restore a trashed note, folder or workspace.

        Args:
            item_type: "note", "folder" or "workspace".
            item_id: The trashed item's id.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if item_type not in ("note", "folder", "workspace"):
            return {"error": "invalid_item_type"}
        project_id = await _project_of(item_type, item_id)
        role = await data.get_membership_role(user.id, project_id) if project_id else None
        if role is None:
            return NOT_FOUND
        needed = ("owner",) if item_type == "workspace" else WRITE_ROLES
        if role not in needed:
            return FORBIDDEN
        if item_type == "note":
            ok = await data.restore_note(item_id)
        elif item_type == "folder":
            ok = await data.restore_folder(item_id)
        else:
            ok = await data.restore_project(item_id)
        return {"ok": ok} if ok else {"error": "conflict"}

    @mcp.tool(title="Purge from trash (permanent)", annotations=_PURGE)
    async def purge(item_type: str, item_id: str) -> dict:
        """Permanently delete a trashed note, folder or workspace. Irreversible —
        there is no undo. Notes/folders need editor+, a workspace needs owner.

        Args:
            item_type: "note", "folder" or "workspace".
            item_id: The trashed item's id.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if item_type not in ("note", "folder", "workspace"):
            return {"error": "invalid_item_type"}
        project_id = await _project_of(item_type, item_id)
        role = await data.get_membership_role(user.id, project_id) if project_id else None
        if role is None:
            return NOT_FOUND
        needed = ("owner",) if item_type == "workspace" else WRITE_ROLES
        if role not in needed:
            return FORBIDDEN
        if item_type == "note":
            await data.purge_note(item_id)
        elif item_type == "folder":
            await data.purge_folder(item_id)
        else:
            await data.purge_project(item_id)
        return {"ok": True}
