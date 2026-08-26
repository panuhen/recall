"""recall FastMCP backend.

Serves, from a single app:
- an MCP server (Streamable HTTP) at /mcp exposing the knowledge tools
  (search, notes, organize, trash, insight, history) plus a `ping` liveness check
- the REST /api the web BFF calls, and a plain /health endpoint it can poll

Runs `alembic upgrade head` on startup before serving.
"""
from __future__ import annotations

import io
import logging
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import asyncpg
from fastmcp import FastMCP
from mcp.types import Icon
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response

from . import config, data, state, tasks
from .auth import build_mcp_auth, resolve_identity
from .db import run_migrations
from .embeddings_provider import embed_query
from .oauth_ui import apply_recall_oauth_branding
from .tools import register_tools

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("recall")

STATIC_DIR = Path(__file__).parent / "static"

# Icons advertised to MCP clients (Claude, Copilot) in the server handshake, so
# the re:call mark shows next to the connector. Absolute URLs built off the
# public base URL; the routes below serve the bytes. The theme-adaptive SVG is
# listed first (preferred); the PNG is a raster fallback for clients that don't
# render SVG — note a raster can't adapt to the client's light/dark theme.
_icon_base = config.MCP_PUBLIC_URL.rstrip("/")
MCP_ICONS = [
    Icon(src=f"{_icon_base}/favicon.svg", mimeType="image/svg+xml"),
    Icon(src=f"{_icon_base}/icon.png", mimeType="image/png", sizes=["128x128"]),
]


@asynccontextmanager
async def lifespan(_server: FastMCP):
    """Startup/shutdown hooks. On boot, enqueue embeddings for any notes missing
    a vector — self-healing for the enqueue-after-commit crash window and the
    initial rollout. Fire-and-forget so a slow queue never blocks readiness."""
    try:
        await tasks.enqueue_backfill()
    except Exception as exc:  # noqa: BLE001
        log.warning("startup embedding backfill skipped: %s", exc)
    yield {}
    await tasks.close_procrastinate()
    await state.close_pool()


# Re-skin FastMCP's OAuth consent + error pages with re:call branding. Must run
# before build_mcp_auth() instantiates the AzureProvider/OAuthProxy.
apply_recall_oauth_branding()

# Server-level guidance surfaced to MCP clients in the handshake (the client MAY
# fold it into the model's context). This is the universal, client-agnostic place
# to teach recall's markdown conventions — including diagrams.
INSTRUCTIONS = (
    "recall is a shared markdown knowledge base. Notes are standard markdown: "
    "`[[wikilinks]]` create knowledge-graph edges and backlinks, and YAML "
    "frontmatter sets type/tags/status. "
    "Code: fenced ``` code blocks render with syntax highlighting in the reading "
    "view; a language tag (```python) is optional — recall auto-detects the "
    "language — though tagging is more reliable for short snippets. "
    "Diagrams: write a ```mermaid fenced code block in a note body and recall "
    "renders it in the UI (flowchart, sequence, class, state, ER, gantt, "
    "mindmap, and more). Validate a diagram with `preview_diagram` before "
    "create_note/update_note so it renders cleanly for readers. "
    "You act as the signed-in user and see only workspaces they can access; "
    "writes require editor or owner."
)

mcp = FastMCP(
    "recall",
    instructions=INSTRUCTIONS,
    lifespan=lifespan,
    auth=build_mcp_auth(),
    icons=MCP_ICONS,
)


@mcp.tool
def ping() -> str:
    """Liveness check — returns 'pong'."""
    return "pong"


# Knowledge tools (search, notes, organize, trash, insight, history). Thin
# wrappers over data.py, gated by the same membership roles as the REST API.
register_tools(mcp)


@mcp.custom_route("/icon.png", methods=["GET"])
async def icon_png(_request: Request) -> FileResponse:
    """Raster app icon advertised in the MCP handshake (128x128)."""
    return FileResponse(STATIC_DIR / "icon.png", media_type="image/png")


@mcp.custom_route("/favicon.svg", methods=["GET"])
async def favicon_svg(_request: Request) -> FileResponse:
    """Theme-adaptive vector app icon advertised in the MCP handshake."""
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    """Report service + database health for the BFF and infra probes."""
    db_ok = False
    pgvector_ok = False
    try:
        conn = await asyncpg.connect(config.DATABASE_URL)
        try:
            await conn.fetchval("SELECT 1")
            db_ok = True
            pgvector_ok = bool(
                await conn.fetchval(
                    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')"
                )
            )
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("health: db check failed: %s", exc)

    status = "ok" if db_ok else "degraded"
    return JSONResponse(
        {
            "status": status,
            "service": "recall",
            "auth_mode": config.AUTH_MODE,
            "db": db_ok,
            "pgvector": pgvector_ok,
        }
    )


@mcp.custom_route("/api/me", methods=["GET"])
async def api_me(request: Request) -> JSONResponse:
    """Current user + their projects. Provisions the user and a personal
    project on first call."""
    ident = resolve_identity(request)
    if ident is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)

    user = await data.upsert_user(ident["oid"], ident["upn"], ident["name"])
    personal = await data.ensure_personal_project(user.id)
    # Turn any invitations addressed to this UPN into memberships, so a shared
    # workspace shows up on the invitee's next load with no accept step.
    await data.accept_pending_invitations(user.id, user.upn)
    projects = await data.get_user_projects(user.id)
    pinned = await data.get_pinned_projects(user.id)
    favorites = await data.list_favorites(user.id)

    def _proj(p: "data.Project") -> dict:
        return {
            "id": p.id,
            "name": p.name,
            "slug": p.slug,
            "role": p.role,
            "member_count": p.member_count,
            "org_access": p.org_access,
            "is_personal": p.is_personal,
            "created_at": p.created_at,
            "updated_at": p.updated_at,
        }

    return JSONResponse(
        {
            "user": {"id": user.id, "upn": user.upn, "name": user.display_name},
            "personal_project_id": personal.id,
            "projects": [_proj(p) for p in projects],
            # Org-visible workspaces the user pinned (shown in the sidebar in
            # "pinned only" mode; they're viewers, not members).
            "pinned": [_proj(p) for p in pinned],
            # Starred shortcuts (notes/folders/workspaces) in the user's order.
            "favorites": favorites,
        }
    )


@mcp.custom_route("/api/graph", methods=["GET"])
async def api_root_graph(request: Request) -> JSONResponse:
    """Whole-account structure graph across the caller's workspaces."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    return JSONResponse(await data.get_root_graph(user.id))


def _zip_response(name: str, items: list[dict]) -> Response:
    """Build an in-memory zip from export items and return it as a download.
    Notes are small text, so building in memory (vs streaming) is fine."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for it in items:
            z.writestr(it["path"], it["body"])
    filename = f"{name}.zip"
    ascii_name = filename.encode("ascii", "ignore").decode() or "export.zip"
    # Both a plain (ASCII) filename and RFC 5987 filename* for non-ASCII names.
    disposition = (
        f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'
    )
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"content-disposition": disposition},
    )


@mcp.custom_route("/api/projects/{project_id}/export", methods=["GET"])
async def api_export_project(request: Request) -> Response:
    """Export a whole workspace as a .zip (folder tree rebuilt). Any member may
    export (read)."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    if await data.get_membership_role(user.id, project_id) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    tree = await data.get_export_tree(project_id, None)
    return _zip_response(tree["name"], tree["items"])


@mcp.custom_route("/api/folders/{folder_id}/export", methods=["GET"])
async def api_export_folder(request: Request) -> Response:
    """Export a folder subtree as a .zip. Any member of its project may export."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder, role = await _folder_role(user, request.path_params["folder_id"])
    if folder is None or role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    tree = await data.get_export_tree(folder.project_id, folder.id)
    return _zip_response(tree["name"], tree["items"])


@mcp.custom_route("/api/search", methods=["GET"])
async def api_search(request: Request) -> JSONResponse:
    """Hybrid keyword+semantic search across the caller's notes.

    Query params: `q` (required), optional `project_id` to scope to one
    workspace, `limit` (1–50, default 20). `semantic` in the response is false
    when the query couldn't be embedded (keyword-only fallback)."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    q = (request.query_params.get("q") or "").strip()
    if not q:
        return JSONResponse({"results": [], "semantic": False})
    project_id = request.query_params.get("project_id") or None
    if project_id and await data.get_membership_role(user.id, project_id) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        limit = int(request.query_params.get("limit", "20"))
    except ValueError:
        limit = 20
    limit = max(1, min(limit, 50))
    qvec = await embed_query(q)
    results = await data.search_notes(user.id, q, qvec, project_id, limit)
    return JSONResponse({"results": results, "semantic": qvec is not None})


async def _current_user(request: Request):
    ident = resolve_identity(request)
    if ident is None:
        return None
    user = await data.get_user_by_oid(ident["oid"])
    if user is None:
        user = await data.upsert_user(ident["oid"], ident["upn"], ident["name"])
    return user


@mcp.custom_route("/api/notes/recent", methods=["GET"])
async def api_recent_notes(request: Request) -> JSONResponse:
    """Most recently updated notes across all the caller's workspaces."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    notes = await data.query_notes(user.id, limit=20)
    return JSONResponse({"notes": notes})


def _note_json(n: "data.Note") -> dict:
    return {
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
    }


@mcp.custom_route("/api/projects", methods=["POST"])
async def api_create_project(request: Request) -> JSONResponse:
    """Create a new project ("folder") owned by the caller."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    proj = await data.create_project(user.id, name)
    return JSONResponse(
        {
            "id": proj.id,
            "name": proj.name,
            "slug": proj.slug,
            "role": proj.role,
            "member_count": proj.member_count,
            "org_access": proj.org_access,
            "is_personal": proj.is_personal,
            "created_at": proj.created_at,
            "updated_at": proj.updated_at,
        },
        status_code=201,
    )


@mcp.custom_route("/api/projects/{project_id}", methods=["PATCH"])
async def api_update_project(request: Request) -> JSONResponse:
    """Update a workspace — rename and/or set org-wide access. Owner only."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    proj = None
    # Apply org_access first so a combined patch's final row reflects both.
    if "org_access" in body:
        proj = await data.set_org_access(project_id, (body.get("org_access") or "").strip())
        if proj is None:
            return JSONResponse({"error": "invalid access change"}, status_code=400)
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "name required"}, status_code=400)
        proj = await data.rename_project(project_id, name)
        if proj is None:
            return JSONResponse({"error": "not found"}, status_code=404)
    if proj is None:
        return JSONResponse({"error": "nothing to update"}, status_code=400)
    return JSONResponse(
        {"id": proj.id, "name": proj.name, "slug": proj.slug,
         "role": role, "is_personal": proj.is_personal,
         "org_access": proj.org_access,
         "created_at": proj.created_at, "updated_at": proj.updated_at}
    )


@mcp.custom_route("/api/projects/{project_id}", methods=["DELETE"])
async def api_delete_project(request: Request) -> JSONResponse:
    """Archive a project. Owner only; the personal project can't be deleted."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    result = await data.archive_project(project_id)
    if result is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if result == "personal":
        return JSONResponse({"error": "cannot delete personal folder"}, status_code=403)
    return JSONResponse({"ok": True})


# ── Members & sharing ───────────────────────────────────────


@mcp.custom_route("/api/projects/{project_id}/members", methods=["GET"])
async def api_list_members(request: Request) -> JSONResponse:
    """Members + pending invitations for a project. Any member may view."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    members = await data.list_members(project_id)
    invitations = await data.list_pending_invitations(project_id)
    return JSONResponse(
        {
            "members": members,
            "invitations": invitations,
            "your_role": role,
        }
    )


@mcp.custom_route("/api/projects/{project_id}/members", methods=["POST"])
async def api_add_member(request: Request) -> JSONResponse:
    """Share a project: add an existing user immediately, or record an invitation
    for a not-yet-seen colleague. Owner only."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    upn = (body.get("upn") or "").strip()
    new_role = (body.get("role") or "").strip()
    if not upn:
        return JSONResponse({"error": "upn required"}, status_code=400)
    result = await data.add_or_invite_member(project_id, upn, new_role, user.id)
    if result is None:
        return JSONResponse({"error": "invalid invite"}, status_code=400)
    return JSONResponse(result, status_code=201)


@mcp.custom_route("/api/projects/{project_id}/members/{user_id}", methods=["PATCH"])
async def api_update_member(request: Request) -> JSONResponse:
    """Change a member's role (editor/viewer). Owner only."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    new_role = ((await request.json()).get("role") or "").strip()
    ok = await data.update_member_role(
        project_id, request.path_params["user_id"], new_role
    )
    if not ok:
        return JSONResponse({"error": "invalid role change"}, status_code=400)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/projects/{project_id}/members/{user_id}", methods=["DELETE"])
async def api_remove_member(request: Request) -> JSONResponse:
    """Remove a member. The owner may remove anyone (but not themselves); any
    member may remove themselves (leave the workspace)."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    target = request.path_params["user_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner" and target != user.id:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    ok = await data.remove_member(project_id, target)
    if not ok:
        return JSONResponse({"error": "cannot remove"}, status_code=400)
    return JSONResponse({"ok": True})


@mcp.custom_route(
    "/api/projects/{project_id}/invitations/{invite_id}", methods=["DELETE"]
)
async def api_revoke_invitation(request: Request) -> JSONResponse:
    """Revoke a pending invitation so it never resolves on sign-in. Owner only."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    ok = await data.revoke_invitation(project_id, request.path_params["invite_id"])
    if not ok:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"ok": True})


# ── Org-wide visibility & pins ──────────────────────────────


@mcp.custom_route("/api/projects/org", methods=["GET"])
async def api_list_org_projects(request: Request) -> JSONResponse:
    """Org-visible workspaces the caller isn't already a member of — the Browse
    list / show-all source."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    return JSONResponse({"projects": await data.list_org_projects(user.id)})


@mcp.custom_route("/api/projects/{project_id}/pin", methods=["POST"])
async def api_pin_project(request: Request) -> JSONResponse:
    """Pin an org-visible workspace to the caller's sidebar."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    if not await data.pin_project(user.id, request.path_params["project_id"]):
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/projects/{project_id}/pin", methods=["DELETE"])
async def api_unpin_project(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    await data.unpin_project(user.id, request.path_params["project_id"])
    return JSONResponse({"ok": True})


# ── Favorites (starred shortcuts) ───────────────────────────


@mcp.custom_route("/api/favorites", methods=["GET"])
async def api_list_favorites(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    return JSONResponse({"favorites": await data.list_favorites(user.id)})


@mcp.custom_route("/api/favorites", methods=["POST"])
async def api_add_favorite(request: Request) -> JSONResponse:
    """Star a note/folder/workspace for the caller."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    body = await request.json()
    ok = await data.add_favorite(
        user.id, (body.get("item_type") or ""), (body.get("item_id") or "")
    )
    if not ok:
        return JSONResponse({"error": "cannot favorite"}, status_code=400)
    return JSONResponse({"ok": True}, status_code=201)


@mcp.custom_route("/api/favorites/reorder", methods=["POST"])
async def api_reorder_favorites(request: Request) -> JSONResponse:
    """Rewrite the caller's favorites order from a supplied list."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    items = (await request.json()).get("items") or []
    await data.reorder_favorites(user.id, items)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/favorites/{item_type}/{item_id}", methods=["DELETE"])
async def api_remove_favorite(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    await data.remove_favorite(
        user.id, request.path_params["item_type"], request.path_params["item_id"]
    )
    return JSONResponse({"ok": True})


async def _folder_role(user, folder_id: str):
    """Resolve a folder → its project → the caller's role. Returns (folder, role)."""
    folder = await data.get_folder(folder_id)
    if folder is None:
        return None, None
    return folder, await data.get_membership_role(user.id, folder.project_id)


@mcp.custom_route("/api/projects/{project_id}/tree", methods=["GET"])
async def api_list_tree(request: Request) -> JSONResponse:
    """Folders + notes for a project — one call to render the sidebar subtree."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    if await data.get_membership_role(user.id, project_id) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(
        {
            "folders": await data.list_folders(project_id),
            "notes": await data.list_notes(project_id),
        }
    )


@mcp.custom_route("/api/projects/{project_id}/graph", methods=["GET"])
async def api_project_graph(request: Request) -> JSONResponse:
    """Nodes + links for a project's knowledge graph. Any member may read."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    if await data.get_membership_role(user.id, project_id) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(await data.get_graph(project_id))


@mcp.custom_route("/api/projects/{project_id}/folders", methods=["POST"])
async def api_create_folder(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    folder = await data.create_folder(project_id, body.get("parent_id"), name, user.id)
    if folder is None:
        return JSONResponse({"error": "invalid parent"}, status_code=400)
    return JSONResponse(
        {"id": folder.id, "project_id": folder.project_id,
         "parent_id": folder.parent_id, "name": folder.name},
        status_code=201,
    )


@mcp.custom_route("/api/folders/{folder_id}", methods=["PATCH"])
async def api_rename_folder(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder, role = await _folder_role(user, request.path_params["folder_id"])
    if folder is None or role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    name = ((await request.json()).get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    updated = await data.rename_folder(folder.id, name)
    return JSONResponse(
        {"id": updated.id, "project_id": updated.project_id,
         "parent_id": updated.parent_id, "name": updated.name}
    )


@mcp.custom_route("/api/folders/{folder_id}", methods=["DELETE"])
async def api_delete_folder(request: Request) -> JSONResponse:
    """Trash a folder and everything inside it (recursive soft-delete)."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder, role = await _folder_role(user, request.path_params["folder_id"])
    if folder is None or role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    await data.archive_folder(folder.id)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/folders/{folder_id}/copy", methods=["POST"])
async def api_copy_folder(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder, role = await _folder_role(user, request.path_params["folder_id"])
    if folder is None or role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    copy = await data.copy_folder(folder.id, user.id)
    return JSONResponse(
        {"id": copy.id, "project_id": copy.project_id,
         "parent_id": copy.parent_id, "name": copy.name},
        status_code=201,
    )


@mcp.custom_route("/api/folders/{folder_id}/move", methods=["POST"])
async def api_move_folder(request: Request) -> JSONResponse:
    """Move a folder under another folder (parent_id NULL = project root).
    `project_id` defaults to the folder's current project; a different one moves
    the whole subtree across projects. Requires write in both source and target."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder, role = await _folder_role(user, request.path_params["folder_id"])
    if folder is None or role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    target = body.get("project_id") or folder.project_id
    target_role = await data.get_membership_role(user.id, target)
    if target_role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if target_role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    parent_id = body.get("parent_id")
    if parent_id is not None:
        parent = await data.get_folder(parent_id)
        if parent is None or parent.project_id != target:
            return JSONResponse({"error": "invalid folder"}, status_code=400)
    moved = await data.move_folder(folder.id, target, parent_id, user.id)
    if moved is None:
        return JSONResponse({"error": "invalid move"}, status_code=400)
    return JSONResponse(
        {"id": moved.id, "project_id": moved.project_id,
         "parent_id": moved.parent_id, "name": moved.name}
    )


@mcp.custom_route("/api/projects/{project_id}/notes", methods=["GET"])
async def api_list_notes(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    if await data.get_membership_role(user.id, project_id) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"notes": await data.list_notes(project_id)})


@mcp.custom_route("/api/projects/{project_id}/notes", methods=["POST"])
async def api_create_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    title = (body.get("title") or "Untitled").strip() or "Untitled"
    folder_id = body.get("folder_id")
    if folder_id is not None:
        folder = await data.get_folder(folder_id)
        if folder is None or folder.project_id != project_id:
            return JSONResponse({"error": "invalid folder"}, status_code=400)
    note = await data.create_note(
        project_id, title, body.get("body") or "", user.id, folder_id
    )
    return JSONResponse(_note_json(note), status_code=201)


@mcp.custom_route("/api/notes/{note_id}", methods=["GET"])
async def api_get_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    backlinks = await data.get_backlinks(note.id)
    links = await data.get_outbound_links(note.id)
    # `can_edit` mirrors the write gate on the mutating routes, so the client can
    # present a viewer a read-only surface instead of an editor that 403s.
    return JSONResponse(
        {
            **_note_json(note),
            "backlinks": backlinks,
            "links": links,
            "can_edit": role in ("owner", "editor"),
        }
    )


@mcp.custom_route("/api/notes/{note_id}", methods=["PATCH"])
async def api_update_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    try:
        updated = await data.update_note(
            note.id,
            body.get("title"),
            body.get("body"),
            user.id,
            base_updated_at=body.get("base_updated_at"),
        )
    except data.StaleUpdate:
        # Someone saved in between — hand back the current note (actor-joined so
        # the client can name who) with 409 so it can reconcile, not clobber.
        current = await data.get_note(note.id)
        return JSONResponse(
            {"error": "conflict", "note": _note_json(current) if current else None},
            status_code=409,
        )
    return JSONResponse(_note_json(updated))


@mcp.custom_route("/api/notes/{note_id}/move", methods=["POST"])
async def api_move_note(request: Request) -> JSONResponse:
    """Move a note to a folder and/or project. `project_id` defaults to the
    note's current project (a plain folder move); `folder_id` NULL = root.
    Requires write access to both the source and target project."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    target = body.get("project_id") or note.project_id
    target_role = await data.get_membership_role(user.id, target)
    if target_role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if target_role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    folder_id = body.get("folder_id")
    if folder_id is not None:
        folder = await data.get_folder(folder_id)
        if folder is None or folder.project_id != target:
            return JSONResponse({"error": "invalid folder"}, status_code=400)
    moved = await data.move_note(note.id, target, folder_id, user.id)
    return JSONResponse(_note_json(moved))


@mcp.custom_route("/api/notes/{note_id}/copy", methods=["POST"])
async def api_copy_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    copy = await data.copy_note(note.id, user.id)
    return JSONResponse(_note_json(copy), status_code=201)


@mcp.custom_route("/api/notes/{note_id}", methods=["DELETE"])
async def api_delete_note(request: Request) -> JSONResponse:
    """Soft-delete a note (recoverable)."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    await data.archive_note(note.id, user.id)
    return JSONResponse({"ok": True})


# ── Trash: restore / purge ──────────────────────────────────


@mcp.custom_route("/api/trash", methods=["GET"])
async def api_list_trash(request: Request) -> JSONResponse:
    """Restorable items for the caller: their archived workspaces + the
    delete-roots in workspaces they can edit."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    return JSONResponse(await data.list_trash(user.id))


async def _trash_role(user, project_id: str | None) -> str | None:
    """Caller's role in a (possibly archived) project, or None if not resolvable
    — the Trash equivalent of the membership check on live routes."""
    if project_id is None:
        return None
    return await data.get_membership_role(user.id, project_id)


@mcp.custom_route("/api/notes/{note_id}/restore", methods=["POST"])
async def api_restore_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note_id = request.path_params["note_id"]
    role = await _trash_role(user, await data.note_project(note_id))
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    ok = await data.restore_note(note_id)
    return JSONResponse({"ok": ok}, status_code=200 if ok else 409)


@mcp.custom_route("/api/notes/{note_id}/purge", methods=["DELETE"])
async def api_purge_note(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note_id = request.path_params["note_id"]
    role = await _trash_role(user, await data.note_project(note_id))
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    await data.purge_note(note_id)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/folders/{folder_id}/restore", methods=["POST"])
async def api_restore_folder(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder_id = request.path_params["folder_id"]
    role = await _trash_role(user, await data.folder_project(folder_id))
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    ok = await data.restore_folder(folder_id)
    return JSONResponse({"ok": ok}, status_code=200 if ok else 409)


@mcp.custom_route("/api/folders/{folder_id}/purge", methods=["DELETE"])
async def api_purge_folder(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    folder_id = request.path_params["folder_id"]
    role = await _trash_role(user, await data.folder_project(folder_id))
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    await data.purge_folder(folder_id)
    return JSONResponse({"ok": True})


@mcp.custom_route("/api/projects/{project_id}/restore", methods=["POST"])
async def api_restore_project(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    ok = await data.restore_project(project_id)
    return JSONResponse({"ok": ok}, status_code=200 if ok else 409)


@mcp.custom_route("/api/projects/{project_id}/purge", methods=["DELETE"])
async def api_purge_project(request: Request) -> JSONResponse:
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    project_id = request.path_params["project_id"]
    role = await data.get_membership_role(user.id, project_id)
    if role is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if role != "owner":
        return JSONResponse({"error": "forbidden"}, status_code=403)
    await data.purge_project(project_id)
    return JSONResponse({"ok": True})


# ── Version history ─────────────────────────────────────────


async def _note_for(request: Request):
    """(user, note, role) for a /notes/{note_id}/… route, or a JSONResponse to
    return early (401/404). Read access = any membership; callers gate writes."""
    user = await _current_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    note = await data.get_note(request.path_params["note_id"])
    if note is None or (role := await data.get_membership_role(user.id, note.project_id)) is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return user, note, role


@mcp.custom_route("/api/notes/{note_id}/related", methods=["GET"])
async def api_related_notes(request: Request) -> JSONResponse:
    """Semantic neighbors of a note (same workspace, already-linked notes
    excluded) — the web UI's 'Related' section under Backlinks. Empty until
    the note has been embedded."""
    ctx = await _note_for(request)
    if isinstance(ctx, JSONResponse):
        return ctx
    _user, note, _role = ctx
    return JSONResponse({"related": await data.suggest_links(note.id, 5)})


@mcp.custom_route("/api/notes/{note_id}/revisions", methods=["GET"])
async def api_list_revisions(request: Request) -> JSONResponse:
    ctx = await _note_for(request)
    if isinstance(ctx, JSONResponse):
        return ctx
    _user, note, _role = ctx
    return JSONResponse({"revisions": await data.list_revisions(note.id)})


@mcp.custom_route("/api/notes/{note_id}/revisions/{rev_id}", methods=["GET"])
async def api_get_revision(request: Request) -> JSONResponse:
    ctx = await _note_for(request)
    if isinstance(ctx, JSONResponse):
        return ctx
    _user, note, _role = ctx
    rev = await data.get_revision(note.id, request.path_params["rev_id"])
    if rev is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(rev)


@mcp.custom_route("/api/notes/{note_id}/revisions", methods=["POST"])
async def api_create_revision(request: Request) -> JSONResponse:
    """Manual 'Save version' — snapshot the current body with an optional label."""
    ctx = await _note_for(request)
    if isinstance(ctx, JSONResponse):
        return ctx
    user, note, role = ctx
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    label = ((await request.json()).get("label") or "").strip() or None
    if not await data.create_revision(note.id, user.id, label):
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"revisions": await data.list_revisions(note.id)}, status_code=201)


@mcp.custom_route("/api/notes/{note_id}/revisions/{rev_id}/restore", methods=["POST"])
async def api_restore_revision(request: Request) -> JSONResponse:
    ctx = await _note_for(request)
    if isinstance(ctx, JSONResponse):
        return ctx
    user, note, role = ctx
    if role not in ("owner", "editor"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    restored = await data.restore_revision(note.id, request.path_params["rev_id"], user.id)
    if restored is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(_note_json(restored))


def main() -> None:
    run_migrations()
    log.info("Starting recall MCP server on %s:%s", config.MCP_HOST, config.MCP_PORT)
    mcp.run(
        transport="http",
        host=config.MCP_HOST,
        port=config.MCP_PORT,
        allowed_hosts=config.MCP_ALLOWED_HOSTS,
    )


if __name__ == "__main__":
    main()
