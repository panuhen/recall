"""Sharing & membership tools: list/add/change/remove members, revoke invites,
and discover org-wide workspaces.

Mirrors the REST sharing routes: viewing membership needs any membership;
changing it (share, set role, revoke) needs owner. Removing a member is allowed
for the owner (anyone but themselves) or for a member removing themselves
(leaving the workspace).
"""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ._base import FORBIDDEN, NOT_FOUND, UNAUTH, resolve_user

_READ = {"readOnlyHint": True, "openWorldHint": False}
_WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="List workspace members", annotations=_READ)
    async def list_members(project_id: str) -> dict:
        """Members and pending invitations of a workspace, plus your own role.
        Any member may view. Member entries carry the user_id needed by
        `set_member_role` / `remove_member`."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        return {
            "members": await data.list_members(project_id),
            "invitations": await data.list_pending_invitations(project_id),
            "your_role": role,
        }

    @mcp.tool(title="Share a workspace", annotations=_WRITE)
    async def share_workspace(project_id: str, upn: str, role: str = "viewer") -> dict:
        """Share a workspace with a colleague by their UPN/email (owner only).

        Adds them immediately if they already have a recall account, otherwise
        records an invitation that resolves on their first sign-in.

        Args:
            project_id: The workspace to share.
            upn: The colleague's UPN / email address.
            role: "viewer" (read) or "editor" (read + write). Default "viewer".
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role_self = await data.get_membership_role(user.id, project_id)
        if role_self is None:
            return NOT_FOUND
        if role_self != "owner":
            return FORBIDDEN
        if not (upn or "").strip():
            return {"error": "upn_required"}
        result = await data.add_or_invite_member(
            project_id, upn.strip(), (role or "").strip(), user.id
        )
        if result is None:
            return {"error": "invalid_invite"}
        return result

    @mcp.tool(title="Set a member's role", annotations=_WRITE)
    async def set_member_role(project_id: str, user_id: str, role: str) -> dict:
        """Change a member's role (owner only).

        Args:
            project_id: The workspace.
            user_id: The member's user id (from `list_members`).
            role: "viewer" or "editor".
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role_self = await data.get_membership_role(user.id, project_id)
        if role_self is None:
            return NOT_FOUND
        if role_self != "owner":
            return FORBIDDEN
        ok = await data.update_member_role(project_id, user_id, (role or "").strip())
        return {"ok": True} if ok else {"error": "invalid_role_change"}

    @mcp.tool(title="Remove a member", annotations=_WRITE)
    async def remove_member(project_id: str, user_id: str) -> dict:
        """Remove a member, or leave the workspace yourself (owner only for
        others; any member may remove themselves).

        Args:
            project_id: The workspace.
            user_id: The member to remove (your own id to leave).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role_self = await data.get_membership_role(user.id, project_id)
        if role_self is None:
            return NOT_FOUND
        if role_self != "owner" and user_id != user.id:
            return FORBIDDEN
        ok = await data.remove_member(project_id, user_id)
        return {"ok": True} if ok else {"error": "cannot_remove"}

    @mcp.tool(title="Revoke an invitation", annotations=_WRITE)
    async def revoke_invitation(project_id: str, invitation_id: str) -> dict:
        """Revoke a pending invitation so it never resolves on sign-in (owner
        only). Invitation ids come from `list_members`."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role_self = await data.get_membership_role(user.id, project_id)
        if role_self is None:
            return NOT_FOUND
        if role_self != "owner":
            return FORBIDDEN
        ok = await data.revoke_invitation(project_id, invitation_id)
        return {"ok": True} if ok else NOT_FOUND

    @mcp.tool(title="List org-wide workspaces", annotations=_READ)
    async def list_org_workspaces() -> dict:
        """Workspaces shared with the whole organisation that you can read but
        aren't a member of — the discovery / browse list. Use `read_note` and
        `search` to read their contents."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        return {"workspaces": await data.list_org_projects(user.id)}
