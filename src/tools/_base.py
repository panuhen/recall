"""Shared helpers for MCP tools.

Every tool resolves the caller exactly as `/api/me` does (provision the user +
their personal workspace on first touch) and gates writes with the same
`get_membership_role` check the REST routes use — one authorization path for
both interfaces. Tools return plain dicts; errors are `{"error": <code>}` so an
assistant gets a legible signal instead of an exception.
"""
from __future__ import annotations

from .. import auth, data
from ..links import note_url

UNAUTH: dict = {"error": "unauthenticated"}
NOT_FOUND: dict = {"error": "not_found"}
FORBIDDEN: dict = {"error": "forbidden"}

WRITE_ROLES = ("owner", "editor")


async def resolve_user() -> "data.User | None":
    """The recall user behind the current MCP call, provisioning on first sight.
    None when the request carries no valid identity (auth on, no token)."""
    ident = auth.mcp_identity()
    if ident is None:
        return None
    user = await data.get_user_by_external_id(ident["oid"])
    if user is None:
        user = await data.upsert_user(ident["oid"], ident["upn"], ident["name"])
        await data.ensure_personal_project(user.id)
        await data.accept_pending_invitations(user.id, user.upn)
    return user


async def note_and_role(user, note_id: str):
    """(note, role) for a note the caller can at least read; (None, None) if the
    note is missing or the caller has no membership in its project."""
    note = await data.get_note(note_id)
    if note is None:
        return None, None
    return note, await data.get_membership_role(user.id, note.project_id)


async def folder_and_role(user, folder_id: str):
    """(folder, role) for a folder resolved through its project's membership."""
    folder = await data.get_folder(folder_id)
    if folder is None:
        return None, None
    return folder, await data.get_membership_role(user.id, folder.project_id)


def note_dict(n, **extra) -> dict:
    """Serialize a Note for an assistant (full body + frontmatter metadata)."""
    d = {
        "id": n.id,
        "project_id": n.project_id,
        "folder_id": n.folder_id,
        "title": n.title,
        "slug": n.slug,
        "body": n.body,
        "type": n.type,
        "tags": n.tags,
        "status": n.status,
        "metadata": n.metadata,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "created_by": n.created_by,
        "updated_by": n.updated_by,
        "created_via": n.created_via,
        "updated_via": n.updated_via,
        "url": note_url(n.id),
    }
    d.update(extra)
    return d


async def written_note_dict(n, **extra) -> dict:
    """note_dict for a note just written. Write queries don't join `users`, so
    their Note carries created_by/updated_by as None; re-read it so the
    response names the author the way read_note does."""
    fresh = await data.get_note(n.id)
    return note_dict(fresh or n, **extra)


def folder_dict(f) -> dict:
    return {
        "id": f.id,
        "project_id": f.project_id,
        "parent_id": f.parent_id,
        "name": f.name,
    }
