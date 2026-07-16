"""Workspace & structure tools: list workspaces/tree, folders, move/copy/delete.

`move`, `copy` and `delete` are keyed by `item_type` ("note" | "folder") so the
surface stays small — one verb each instead of one per kind.
"""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ._base import (
    FORBIDDEN,
    NOT_FOUND,
    UNAUTH,
    WRITE_ROLES,
    folder_and_role,
    folder_dict,
    note_and_role,
    note_dict,
    resolve_user,
)

_READ = {"readOnlyHint": True, "openWorldHint": False}
_WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}
# Soft-delete: recoverable from Trash, so not flagged destructive.
_SOFT_DELETE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}


def _project_dict(p) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "slug": p.slug,
        "role": p.role,
        "is_personal": p.is_personal,
        "org_access": p.org_access,
        "member_count": p.member_count,
        "updated_at": p.updated_at,
    }


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="List workspaces", annotations=_READ)
    async def list_projects() -> dict:
        """The workspaces (projects) you belong to, with your role in each."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        projects = await data.get_user_projects(user.id)
        return {"projects": [_project_dict(p) for p in projects]}

    @mcp.tool(title="Create a workspace", annotations=_WRITE)
    async def create_workspace(name: str) -> dict:
        """Create a new workspace (project) owned by you.

        Args:
            name: Workspace name.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if not (name or "").strip():
            return {"error": "name_required"}
        return _project_dict(await data.create_project(user.id, name.strip()))

    @mcp.tool(title="Rename a workspace", annotations=_WRITE)
    async def rename_workspace(project_id: str, name: str) -> dict:
        """Rename a workspace (owner only)."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        if role != "owner":
            return FORBIDDEN
        if not (name or "").strip():
            return {"error": "name_required"}
        proj = await data.rename_project(project_id, name.strip())
        if proj is None:
            return NOT_FOUND
        return _project_dict(proj)

    @mcp.tool(title="Set workspace visibility", annotations=_WRITE)
    async def set_workspace_access(project_id: str, org_access: str) -> dict:
        """Set a workspace's organisation-wide visibility (owner only).

        Args:
            project_id: The workspace.
            org_access: "none" (private) or "viewer" (anyone in the org can find
                and read it).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        if role != "owner":
            return FORBIDDEN
        proj = await data.set_org_access(project_id, (org_access or "").strip())
        if proj is None:
            return {"error": "invalid_access"}
        return _project_dict(proj)

    @mcp.tool(title="Delete a workspace", annotations=_SOFT_DELETE)
    async def delete_workspace(project_id: str) -> dict:
        """Move a whole workspace to Trash (owner only). Recoverable with
        `restore`. The personal workspace can't be deleted."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        if role != "owner":
            return FORBIDDEN
        result = await data.archive_project(project_id)
        if result is None:
            return NOT_FOUND
        if result == "personal":
            return {"error": "cannot_delete_personal"}
        return {"ok": True}

    @mcp.tool(title="List a workspace's contents", annotations=_READ)
    async def list_tree(project_id: str) -> dict:
        """Folders and notes in a workspace — the whole tree in one call."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        return {
            "folders": await data.list_folders(project_id),
            "notes": await data.list_notes(project_id),
        }

    @mcp.tool(title="Create a folder", annotations=_WRITE)
    async def create_folder(
        project_id: str, name: str, parent_id: str | None = None
    ) -> dict:
        """Create a folder in a workspace (editor+). `parent_id` nests it; omit
        for a top-level folder."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        if not (name or "").strip():
            return {"error": "name_required"}
        folder = await data.create_folder(project_id, parent_id, name.strip(), user.id)
        if folder is None:
            return {"error": "invalid_parent"}
        return folder_dict(folder)

    @mcp.tool(title="Rename a folder", annotations=_WRITE)
    async def rename_folder(folder_id: str, name: str) -> dict:
        """Rename a folder (editor+)."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        folder, role = await folder_and_role(user, folder_id)
        if folder is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        if not (name or "").strip():
            return {"error": "name_required"}
        return folder_dict(await data.rename_folder(folder.id, name.strip()))

    @mcp.tool(title="Move a note or folder", annotations=_WRITE)
    async def move(
        item_type: str,
        item_id: str,
        project_id: str | None = None,
        folder_id: str | None = None,
        parent_id: str | None = None,
    ) -> dict:
        """Move a note or folder within or across workspaces (editor+ in both).

        Args:
            item_type: "note" or "folder".
            item_id: The note or folder to move.
            project_id: Target workspace; defaults to the item's current one.
            folder_id: For a note — target folder (omit/null = workspace root).
            parent_id: For a folder — target parent folder (omit/null = root).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if item_type == "note":
            note, role = await note_and_role(user, item_id)
            if note is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            target = project_id or note.project_id
            trole = await data.get_membership_role(user.id, target)
            if trole is None:
                return NOT_FOUND
            if trole not in WRITE_ROLES:
                return FORBIDDEN
            if folder_id is not None:
                f = await data.get_folder(folder_id)
                if f is None or f.project_id != target:
                    return {"error": "invalid_folder"}
            return note_dict(await data.move_note(note.id, target, folder_id, user.id))
        if item_type == "folder":
            folder, role = await folder_and_role(user, item_id)
            if folder is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            target = project_id or folder.project_id
            trole = await data.get_membership_role(user.id, target)
            if trole is None:
                return NOT_FOUND
            if trole not in WRITE_ROLES:
                return FORBIDDEN
            if parent_id is not None:
                p = await data.get_folder(parent_id)
                if p is None or p.project_id != target:
                    return {"error": "invalid_folder"}
            moved = await data.move_folder(folder.id, target, parent_id, user.id)
            if moved is None:
                return {"error": "invalid_move"}
            return folder_dict(moved)
        return {"error": "invalid_item_type"}

    @mcp.tool(title="Copy a note or folder", annotations=_WRITE)
    async def copy(item_type: str, item_id: str) -> dict:
        """Duplicate a note or folder in place (editor+).

        Args:
            item_type: "note" or "folder".
            item_id: The note or folder to copy.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if item_type == "note":
            note, role = await note_and_role(user, item_id)
            if note is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            return note_dict(await data.copy_note(note.id, user.id))
        if item_type == "folder":
            folder, role = await folder_and_role(user, item_id)
            if folder is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            return folder_dict(await data.copy_folder(folder.id, user.id))
        return {"error": "invalid_item_type"}

    @mcp.tool(title="Delete a note or folder", annotations=_SOFT_DELETE)
    async def delete(item_type: str, item_id: str) -> dict:
        """Move a note or folder to Trash (editor+). Recoverable with `restore`;
        a folder takes everything inside it. This is a soft delete — use `purge`
        to remove permanently.

        Args:
            item_type: "note" or "folder".
            item_id: The note or folder to trash.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if item_type == "note":
            note, role = await note_and_role(user, item_id)
            if note is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            await data.archive_note(note.id, user.id)
            return {"ok": True}
        if item_type == "folder":
            folder, role = await folder_and_role(user, item_id)
            if folder is None or role is None:
                return NOT_FOUND
            if role not in WRITE_ROLES:
                return FORBIDDEN
            await data.archive_folder(folder.id)
            return {"ok": True}
        return {"error": "invalid_item_type"}
