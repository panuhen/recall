"""Data-access layer — shared by the REST API and (later) the MCP tools.

Plain asyncpg queries + dataclasses. No ORM.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import config
from .auth import mcp_client_name
from .embeddings_provider import to_pgvector
from .markdown import (
    UNSAFE_WIKILINK_TITLE_CHARS,
    extract_wikilinks,
    parse_frontmatter,
    project_metadata,
    rewrite_wikilink_target,
    slugify,
)
from .state import get_pool
from .tasks import enqueue_embed


def _via() -> str | None:
    """Client attribution for the current write: the MCP client's self-reported
    name (Claude, openai-mcp, …) when the call runs inside an MCP session, None
    when it came through the web BFF. Resolved here — not threaded through every
    signature — so REST and MCP share one write path."""
    return mcp_client_name()


@dataclass
class User:
    id: str
    external_id: str
    upn: str
    display_name: str | None
    idp: str = "entra"


@dataclass
class Project:
    id: str
    name: str
    slug: str
    owner_id: str
    is_personal: bool
    role: str | None = None
    member_count: int | None = None
    org_access: str = "none"
    created_at: str | None = None
    updated_at: str | None = None


def _user(row) -> User:
    return User(
        id=str(row["id"]),
        external_id=row["external_id"],
        upn=row["upn"],
        display_name=row["display_name"],
        idp=row["idp"],
    )


def _project(row) -> Project:
    return Project(
        id=str(row["id"]),
        name=row["name"],
        slug=row["slug"],
        owner_id=str(row["owner_id"]),
        is_personal=row["is_personal"],
        role=row["role"] if "role" in row else None,
        member_count=row["member_count"] if "member_count" in row else None,
        org_access=row["org_access"] if "org_access" in row else "none",
        created_at=row["created_at"].isoformat() if "created_at" in row else None,
        updated_at=row["updated_at"].isoformat() if "updated_at" in row else None,
    )


# Values allowed in users.idp (CHECK constraint, migration 009).
_IDPS = ("entra", "betterauth", "dev")


async def upsert_user(
    external_id: str, upn: str, name: str | None, idp: str | None = None
) -> User:
    """Insert or refresh the user provisioned from the identity provider.

    `external_id` is the id the provider knows the user by: the Entra oid, or
    the Better Auth user id (an opaque string). `idp` defaults to the running
    AUTH_MODE. Reconciles on external_id first (the stable id), then on upn —
    so a pre-existing row (e.g. the dev-stub user with the same UPN) is claimed
    by the real identity instead of colliding on the unique upn constraint.
    """
    idp = idp or (config.AUTH_MODE if config.AUTH_MODE in _IDPS else "entra")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if await conn.fetchrow("SELECT 1 FROM users WHERE external_id = $1", external_id):
                row = await conn.fetchrow(
                    "UPDATE users SET upn = $2, display_name = $3, idp = $4, "
                    "updated_at = now() WHERE external_id = $1 RETURNING *",
                    external_id, upn, name, idp,
                )
                return _user(row)

            if await conn.fetchrow("SELECT 1 FROM users WHERE upn = $1", upn):
                row = await conn.fetchrow(
                    "UPDATE users SET external_id = $1, display_name = $3, idp = $4, "
                    "updated_at = now() WHERE upn = $2 RETURNING *",
                    external_id, upn, name, idp,
                )
                return _user(row)

            row = await conn.fetchrow(
                "INSERT INTO users (external_id, upn, display_name, idp) "
                "VALUES ($1, $2, $3, $4) RETURNING *",
                external_id, upn, name, idp,
            )
            return _user(row)


async def ensure_personal_project(user_id: str) -> Project:
    """Return the user's personal project, creating it (with owner membership) if absent."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT * FROM projects "
                "WHERE owner_id = $1::uuid AND is_personal = TRUE LIMIT 1",
                user_id,
            )
            if row is None:
                row = await conn.fetchrow(
                    """
                    INSERT INTO projects (name, slug, owner_id, is_personal)
                    VALUES ('Personal', 'personal', $1::uuid, TRUE)
                    RETURNING *
                    """,
                    user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO project_members (project_id, user_id, role)
                    VALUES ($1, $2::uuid, 'owner')
                    ON CONFLICT DO NOTHING
                    """,
                    row["id"],
                    user_id,
                )
    proj = _project(row)
    proj.role = "owner"
    return proj


async def _unique_project_slug(conn, owner_id: str, base: str) -> str:
    base = base or "folder"
    slug, i = base, 2
    while await conn.fetchrow(
        "SELECT 1 FROM projects WHERE owner_id = $1::uuid AND slug = $2", owner_id, slug
    ):
        slug, i = f"{base}-{i}", i + 1
    return slug


async def create_project(owner_id: str, name: str) -> Project:
    """Create a shared (non-personal) project — a "folder" — owned by the user,
    with an owner membership row."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            slug = await _unique_project_slug(conn, owner_id, slugify(name))
            row = await conn.fetchrow(
                "INSERT INTO projects (name, slug, owner_id, is_personal) "
                "VALUES ($1, $2, $3::uuid, FALSE) RETURNING *",
                name, slug, owner_id,
            )
            await conn.execute(
                "INSERT INTO project_members (project_id, user_id, role) "
                "VALUES ($1, $2::uuid, 'owner') ON CONFLICT DO NOTHING",
                row["id"], owner_id,
            )
    proj = _project(row)
    proj.role = "owner"
    return proj


async def rename_project(project_id: str, name: str) -> Project | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE projects SET name = $2, updated_at = now() "
        "WHERE id = $1::uuid AND archived_at IS NULL RETURNING *",
        project_id, name,
    )
    return _project(row) if row else None


async def archive_project(project_id: str) -> str | None:
    """Archive a project. Returns 'ok', 'personal' (refused), or None (not found)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_personal FROM projects WHERE id = $1::uuid AND archived_at IS NULL",
            project_id,
        )
        if row is None:
            return None
        if row["is_personal"]:
            return "personal"
        await conn.execute(
            "UPDATE projects SET archived_at = now() WHERE id = $1::uuid", project_id
        )
    return "ok"


async def get_user_projects(user_id: str) -> list[Project]:
    """All non-archived projects the user is a member of, with their role."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT p.*, m.role,
               (SELECT count(*) FROM project_members pm
                WHERE pm.project_id = p.id) AS member_count
        FROM projects p
        JOIN project_members m ON m.project_id = p.id
        WHERE m.user_id = $1::uuid AND p.archived_at IS NULL
        ORDER BY p.is_personal DESC, p.name
        """,
        user_id,
    )
    return [_project(r) for r in rows]


async def get_membership_role(user_id: str, project_id: str) -> str | None:
    """The user's *effective* role in a project, or None if they can't see it.

    Explicit membership wins; failing that, an org-visible workspace grants
    'viewer' to anyone in the org. This is the single authorization chokepoint
    every route checks, so org-wide read access flows from here with no
    per-route changes (writes still require owner/editor). "The org" is every
    user of this instance: the Entra tenant in entra mode, and everyone who has
    signed in (any Google account Better Auth admits) in betterauth mode."""
    pool = await get_pool()
    return await pool.fetchval(
        """
        SELECT COALESCE(
            (SELECT role FROM project_members
             WHERE user_id = $1::uuid AND project_id = $2::uuid),
            (SELECT 'viewer' FROM projects
             WHERE id = $2::uuid AND org_access = 'viewer' AND archived_at IS NULL)
        )
        """,
        user_id,
        project_id,
    )


async def get_user_by_external_id(external_id: str) -> User | None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT * FROM users WHERE external_id = $1", external_id)
    return _user(row) if row else None


async def search_users(q: str, limit: int = 10) -> list[dict]:
    """People-picker lookup over recall's own users (name or upn, ILIKE).

    Returns `{oid, upn, name}` — the same shape the Graph-backed directory
    search yields in entra mode, with `oid` = the provider's external id.
    LIKE wildcards in `q` are escaped so they match literally.
    """
    pattern = "%" + re.sub(r"([\\%_])", r"\\\1", q) + "%"
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT external_id, upn, display_name FROM users
        WHERE display_name ILIKE $1 OR upn ILIKE $1
        ORDER BY display_name NULLS LAST, upn
        LIMIT $2
        """,
        pattern,
        limit,
    )
    return [
        {"oid": r["external_id"], "upn": r["upn"], "name": r["display_name"] or ""}
        for r in rows
    ]


# ── Membership & sharing ────────────────────────────────────


async def list_members(project_id: str) -> list[dict]:
    """A project's members (joined to users), owner→editor→viewer then name."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT u.id AS user_id, u.upn, u.display_name, m.role, m.added_at
        FROM project_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1::uuid
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                 lower(coalesce(u.display_name, u.upn))
        """,
        project_id,
    )
    return [
        {
            "user_id": str(r["user_id"]),
            "upn": r["upn"],
            "display_name": r["display_name"],
            "role": r["role"],
            "added_at": r["added_at"].isoformat(),
        }
        for r in rows
    ]


async def list_pending_invitations(project_id: str) -> list[dict]:
    """A project's outstanding invitations (awaiting the invitee's first sign-in)."""
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, invited_upn, role, created_at FROM invitations "
        "WHERE project_id = $1::uuid AND status = 'pending' "
        "ORDER BY lower(invited_upn)",
        project_id,
    )
    return [
        {
            "id": str(r["id"]),
            "invited_upn": r["invited_upn"],
            "role": r["role"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


async def add_or_invite_member(
    project_id: str, invited_upn: str, role: str, invited_by: str
) -> dict | None:
    """Share a project with a colleague.

    If they already have a recall account, add them as a member immediately;
    otherwise record a pending invitation that resolves on their first sign-in
    (see `accept_pending_invitations`). Returns a dict tagged with `kind`
    ("member" | "invitation"), or None on a bad request (unknown project, bad
    role, or the target is the project's owner — who can't be demoted).
    """
    upn = invited_upn.strip().lower()
    if role not in ("editor", "viewer") or not upn:
        return None
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT 1 FROM projects WHERE id = $1::uuid AND archived_at IS NULL",
                project_id,
            )
            if not exists:
                return None

            user = await conn.fetchrow(
                "SELECT id, upn, display_name FROM users WHERE lower(upn) = $1", upn
            )
            if user is not None:
                current = await conn.fetchval(
                    "SELECT role FROM project_members "
                    "WHERE project_id = $1::uuid AND user_id = $2",
                    project_id, user["id"],
                )
                if current == "owner":
                    # Owners are managed from the member menu (promote/demote),
                    # never re-invited or silently demoted through this box.
                    return None
                await conn.execute(
                    """
                    INSERT INTO project_members (project_id, user_id, role)
                    VALUES ($1::uuid, $2, $3)
                    ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
                    """,
                    project_id, user["id"], role,
                )
                return {
                    "kind": "member",
                    "user_id": str(user["id"]),
                    "upn": user["upn"],
                    "display_name": user["display_name"],
                    "role": role,
                }

            # No account yet → pending invitation (dedup on project + upn).
            existing = await conn.fetchval(
                "SELECT id FROM invitations "
                "WHERE project_id = $1::uuid AND lower(invited_upn) = $2 "
                "AND status = 'pending'",
                project_id, upn,
            )
            if existing is not None:
                row = await conn.fetchrow(
                    "UPDATE invitations SET role = $2 WHERE id = $1 RETURNING *",
                    existing, role,
                )
            else:
                row = await conn.fetchrow(
                    """
                    INSERT INTO invitations (project_id, invited_upn, role, invited_by)
                    VALUES ($1::uuid, $2, $3, $4::uuid)
                    RETURNING *
                    """,
                    project_id, upn, role, invited_by,
                )
    return {
        "kind": "invitation",
        "id": str(row["id"]),
        "invited_upn": row["invited_upn"],
        "role": row["role"],
        "created_at": row["created_at"].isoformat(),
    }


async def _owner_count(conn, project_id: str) -> int:
    return await conn.fetchval(
        "SELECT count(*) FROM project_members "
        "WHERE project_id = $1::uuid AND role = 'owner'",
        project_id,
    )


async def update_member_role(project_id: str, user_id: str, role: str) -> bool:
    """Change a member's role among owner/editor/viewer. Promotion to owner is
    allowed; demoting the *last* owner is refused (it would orphan the
    workspace)."""
    if role not in ("owner", "editor", "viewer"):
        return False
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            current = await conn.fetchval(
                "SELECT role FROM project_members "
                "WHERE project_id = $1::uuid AND user_id = $2::uuid",
                project_id, user_id,
            )
            if current is None:
                return False
            if current == role:
                return True  # no-op
            if current == "owner" and await _owner_count(conn, project_id) <= 1:
                return False  # can't demote the last owner
            await conn.execute(
                "UPDATE project_members SET role = $3 "
                "WHERE project_id = $1::uuid AND user_id = $2::uuid",
                project_id, user_id, role,
            )
    return True


async def remove_member(project_id: str, user_id: str) -> bool:
    """Remove a member (owner removing someone, or a member leaving). The last
    remaining owner can't be removed — that would orphan the workspace."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            current = await conn.fetchval(
                "SELECT role FROM project_members "
                "WHERE project_id = $1::uuid AND user_id = $2::uuid",
                project_id, user_id,
            )
            if current is None:
                return False
            if current == "owner" and await _owner_count(conn, project_id) <= 1:
                return False
            row = await conn.fetchrow(
                "DELETE FROM project_members "
                "WHERE project_id = $1::uuid AND user_id = $2::uuid "
                "RETURNING user_id",
                project_id, user_id,
            )
    return row is not None


async def revoke_invitation(project_id: str, invite_id: str) -> bool:
    """Revoke a pending invitation (so it never resolves on sign-in)."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE invitations SET status = 'revoked' "
        "WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'pending' "
        "RETURNING id",
        invite_id, project_id,
    )
    return row is not None


async def accept_pending_invitations(user_id: str, upn: str) -> int:
    """Convert this user's pending invitations into memberships. Called on
    sign-in so shared workspaces appear without an accept step. Idempotent;
    returns the number newly accepted."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                "SELECT id, project_id, role FROM invitations "
                "WHERE lower(invited_upn) = lower($1) AND status = 'pending'",
                upn,
            )
            for r in rows:
                await conn.execute(
                    """
                    INSERT INTO project_members (project_id, user_id, role)
                    VALUES ($1, $2::uuid, $3)
                    ON CONFLICT (project_id, user_id) DO NOTHING
                    """,
                    r["project_id"], user_id, r["role"],
                )
                await conn.execute(
                    "UPDATE invitations SET status = 'accepted', accepted_at = now() "
                    "WHERE id = $1",
                    r["id"],
                )
    return len(rows)


# ── Org-wide visibility & pins ──────────────────────────────


async def set_org_access(project_id: str, value: str) -> Project | None:
    """Set a workspace's org-wide baseline ('none' or 'viewer'). Refused (None)
    on personal workspaces (those are never org-visible)."""
    if value not in ("none", "viewer"):
        return None
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE projects SET org_access = $2, updated_at = now() "
        "WHERE id = $1::uuid AND is_personal = FALSE AND archived_at IS NULL "
        "RETURNING *",
        project_id, value,
    )
    return _project(row) if row else None


async def list_org_projects(user_id: str) -> list[dict]:
    """Org-visible workspaces the caller is NOT already a member of — the Browse
    / show-all list. Carries the owner's name, member count, and whether the
    caller has pinned it."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT p.id, p.name, p.slug, p.updated_at,
               u.display_name AS owner_name, u.upn AS owner_upn,
               (SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id)
                   AS member_count,
               EXISTS (SELECT 1 FROM project_pins pp
                       WHERE pp.project_id = p.id AND pp.user_id = $1::uuid) AS pinned
        FROM projects p
        JOIN users u ON u.id = p.owner_id
        WHERE p.org_access = 'viewer'
          AND p.archived_at IS NULL
          AND p.is_personal = FALSE
          AND NOT EXISTS (SELECT 1 FROM project_members m
                          WHERE m.project_id = p.id AND m.user_id = $1::uuid)
        ORDER BY lower(p.name)
        """,
        user_id,
    )
    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "slug": r["slug"],
            "owner_name": r["owner_name"] or r["owner_upn"],
            "member_count": r["member_count"],
            "pinned": r["pinned"],
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


async def get_pinned_projects(user_id: str) -> list[Project]:
    """Org-visible workspaces the caller has pinned (and isn't a member of),
    surfaced in the sidebar with an effective 'viewer' role."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT p.*, 'viewer' AS role,
               (SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id)
                   AS member_count
        FROM project_pins pin
        JOIN projects p ON p.id = pin.project_id
        WHERE pin.user_id = $1::uuid
          AND p.org_access = 'viewer'
          AND p.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM project_members m
                          WHERE m.project_id = p.id AND m.user_id = $1::uuid)
        ORDER BY lower(p.name)
        """,
        user_id,
    )
    return [_project(r) for r in rows]


async def pin_project(user_id: str, project_id: str) -> bool:
    """Pin a workspace the caller can see (idempotent). Returns False if they
    can't see it."""
    if await get_membership_role(user_id, project_id) is None:
        return False
    pool = await get_pool()
    await pool.execute(
        "INSERT INTO project_pins (user_id, project_id) "
        "VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING",
        user_id, project_id,
    )
    return True


async def unpin_project(user_id: str, project_id: str) -> None:
    pool = await get_pool()
    await pool.execute(
        "DELETE FROM project_pins WHERE user_id = $1::uuid AND project_id = $2::uuid",
        user_id, project_id,
    )


# ── Favorites (starred shortcuts) ───────────────────────────

_FAV_TYPES = ("note", "folder", "project")

# Access predicate shared by favorite lookups: the project is visible if the
# caller is a member OR it's org-visible. ($1 = user_id, p = the project).
_FAV_VISIBLE = (
    "(p.org_access = 'viewer' OR EXISTS ("
    " SELECT 1 FROM project_members m"
    " WHERE m.project_id = p.id AND m.user_id = $1::uuid))"
)


async def add_favorite(user_id: str, item_type: str, item_id: str) -> bool:
    """Star a note/folder/workspace. Refused if the type is bad, the item is
    gone, it's the personal workspace, or the caller can't see it."""
    if item_type not in _FAV_TYPES or not item_id:
        return False
    pool = await get_pool()
    async with pool.acquire() as conn:
        if item_type == "project":
            is_personal = await conn.fetchval(
                "SELECT is_personal FROM projects "
                "WHERE id = $1::uuid AND archived_at IS NULL",
                item_id,
            )
            if is_personal is None or is_personal:
                return False  # missing, or the personal workspace (never favorited)
            project_id: object = item_id
        elif item_type == "folder":
            project_id = await conn.fetchval(
                "SELECT project_id FROM folders "
                "WHERE id = $1::uuid AND archived_at IS NULL",
                item_id,
            )
        else:  # note
            project_id = await conn.fetchval(
                "SELECT project_id FROM notes "
                "WHERE id = $1::uuid AND archived_at IS NULL",
                item_id,
            )
        if project_id is None:
            return False
        if await get_membership_role(user_id, str(project_id)) is None:
            return False
        await conn.execute(
            """
            INSERT INTO favorites (user_id, item_type, item_id, position)
            VALUES ($1::uuid, $2, $3::uuid,
                    COALESCE((SELECT max(position) FROM favorites
                              WHERE user_id = $1::uuid), 0) + 1)
            ON CONFLICT (user_id, item_type, item_id) DO NOTHING
            """,
            user_id, item_type, item_id,
        )
    return True


async def remove_favorite(user_id: str, item_type: str, item_id: str) -> None:
    pool = await get_pool()
    await pool.execute(
        "DELETE FROM favorites "
        "WHERE user_id = $1::uuid AND item_type = $2 AND item_id = $3::uuid",
        user_id, item_type, item_id,
    )


async def reorder_favorites(user_id: str, ordered: list[dict]) -> None:
    """Rewrite favorite positions from a client-supplied order (0..n)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            for i, it in enumerate(ordered):
                itype, iid = it.get("item_type"), it.get("item_id")
                if itype not in _FAV_TYPES or not iid:
                    continue
                await conn.execute(
                    "UPDATE favorites SET position = $4 "
                    "WHERE user_id = $1::uuid AND item_type = $2 AND item_id = $3::uuid",
                    user_id, itype, iid, float(i),
                )


async def list_favorites(user_id: str) -> list[dict]:
    """The caller's favorites in saved order, resolved to display items and
    dropped if deleted/archived or no longer visible to them."""
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT item_type, item_id FROM favorites "
        "WHERE user_id = $1::uuid ORDER BY position",
        user_id,
    )
    if not rows:
        return []

    note_ids = [r["item_id"] for r in rows if r["item_type"] == "note"]
    folder_ids = [r["item_id"] for r in rows if r["item_type"] == "folder"]
    project_ids = [r["item_id"] for r in rows if r["item_type"] == "project"]
    resolved: dict[tuple[str, str], dict] = {}

    async with pool.acquire() as conn:
        if note_ids:
            for n in await conn.fetch(
                f"""
                SELECT n.id, n.title, n.project_id
                FROM notes n JOIN projects p ON p.id = n.project_id
                WHERE n.id = ANY($2::uuid[]) AND n.archived_at IS NULL
                  AND p.archived_at IS NULL AND {_FAV_VISIBLE}
                """,
                user_id, note_ids,
            ):
                resolved[("note", str(n["id"]))] = {
                    "type": "note",
                    "id": str(n["id"]),
                    "label": n["title"],
                    "project_id": str(n["project_id"]),
                }
        if folder_ids:
            for f in await conn.fetch(
                f"""
                SELECT f.id, f.name, f.project_id
                FROM folders f JOIN projects p ON p.id = f.project_id
                WHERE f.id = ANY($2::uuid[]) AND f.archived_at IS NULL
                  AND p.archived_at IS NULL AND {_FAV_VISIBLE}
                """,
                user_id, folder_ids,
            ):
                resolved[("folder", str(f["id"]))] = {
                    "type": "folder",
                    "id": str(f["id"]),
                    "label": f["name"],
                    "project_id": str(f["project_id"]),
                }
        if project_ids:
            for p in await conn.fetch(
                f"""
                SELECT p.id, p.name
                FROM projects p
                WHERE p.id = ANY($2::uuid[]) AND p.archived_at IS NULL AND {_FAV_VISIBLE}
                """,
                user_id, project_ids,
            ):
                resolved[("project", str(p["id"]))] = {
                    "type": "project",
                    "id": str(p["id"]),
                    "label": p["name"],
                    "project_id": str(p["id"]),
                }

    out: list[dict] = []
    for r in rows:
        item = resolved.get((r["item_type"], str(r["item_id"])))
        if item is not None:
            out.append(item)
    return out


# ── Folders (organization within a project) ─────────────────


@dataclass
class Folder:
    id: str
    project_id: str
    parent_id: str | None
    name: str


def _folder(row) -> Folder:
    return Folder(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        parent_id=str(row["parent_id"]) if row["parent_id"] else None,
        name=row["name"],
    )


async def get_folder(folder_id: str) -> Folder | None:
    """A single live folder — used to resolve its project for auth checks."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM folders WHERE id = $1::uuid AND archived_at IS NULL", folder_id
    )
    return _folder(row) if row else None


async def create_folder(
    project_id: str, parent_id: str | None, name: str, user_id: str
) -> Folder | None:
    """Create a folder, optionally nested under parent_id. Returns None if
    parent_id is given but doesn't live in project_id."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        if parent_id is not None:
            ok = await conn.fetchval(
                "SELECT 1 FROM folders WHERE id = $1::uuid AND project_id = $2::uuid "
                "AND archived_at IS NULL",
                parent_id, project_id,
            )
            if not ok:
                return None
        row = await conn.fetchrow(
            "INSERT INTO folders (project_id, parent_id, name, created_by) "
            "VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING *",
            project_id, parent_id, name, user_id,
        )
    return _folder(row)


async def rename_folder(folder_id: str, name: str) -> Folder | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE folders SET name = $2, updated_at = now() "
        "WHERE id = $1::uuid AND archived_at IS NULL RETURNING *",
        folder_id, name,
    )
    return _folder(row) if row else None


async def list_folders(project_id: str) -> list[dict]:
    """All live folders in a project; the client builds the tree from parent_id."""
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, project_id, parent_id, name, created_at, updated_at FROM folders "
        "WHERE project_id = $1::uuid AND archived_at IS NULL ORDER BY name",
        project_id,
    )
    return [
        {
            "id": str(r["id"]),
            "project_id": str(r["project_id"]),
            "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
            "name": r["name"],
            "created_at": r["created_at"].isoformat(),
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


# The folder + all its descendants, as a recursive CTE. Reused by archive/copy.
_SUBTREE_CTE = """
    WITH RECURSIVE subtree AS (
        SELECT id, parent_id, name, 0 AS depth
        FROM folders WHERE id = $1::uuid AND archived_at IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, s.depth + 1
        FROM folders f JOIN subtree s ON f.parent_id = s.id
        WHERE f.archived_at IS NULL
    )
"""


async def archive_folder(folder_id: str) -> bool:
    """Soft-delete a folder and everything under it (subfolders + their notes)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT 1 FROM folders WHERE id = $1::uuid AND archived_at IS NULL",
                folder_id,
            )
            if not exists:
                return False
            await conn.execute(
                _SUBTREE_CTE
                + "UPDATE notes SET archived_at = now() "
                "WHERE folder_id IN (SELECT id FROM subtree) AND archived_at IS NULL",
                folder_id,
            )
            await conn.execute(
                _SUBTREE_CTE
                + "UPDATE folders SET archived_at = now() "
                "WHERE id IN (SELECT id FROM subtree)",
                folder_id,
            )
    return True


async def copy_folder(folder_id: str, user_id: str) -> Folder | None:
    """Recursively duplicate a folder subtree (folders + their notes) into the
    same parent. The root copy is renamed '… (copy)'; nested names are kept."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            root = await conn.fetchrow(
                "SELECT * FROM folders WHERE id = $1::uuid AND archived_at IS NULL",
                folder_id,
            )
            if root is None:
                return None
            project_id = str(root["project_id"])
            root_id = str(root["id"])
            # depth-ordered so a parent is always inserted before its children.
            sub = await conn.fetch(
                _SUBTREE_CTE + "SELECT id, parent_id, name FROM subtree ORDER BY depth",
                folder_id,
            )
            id_map: dict[str, str] = {}
            new_root = None
            for r in sub:
                old_id = str(r["id"])
                if old_id == root_id:
                    new_parent, new_name = root["parent_id"], f"{r['name']} (copy)"
                else:
                    new_parent, new_name = id_map[str(r["parent_id"])], r["name"]
                new_row = await conn.fetchrow(
                    "INSERT INTO folders (project_id, parent_id, name, created_by) "
                    "VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING *",
                    project_id, new_parent, new_name, user_id,
                )
                id_map[old_id] = str(new_row["id"])
                if old_id == root_id:
                    new_root = new_row
            # Copy every note that lived in any of the source folders.
            notes = await conn.fetch(
                "SELECT * FROM notes WHERE folder_id = ANY($1::uuid[]) "
                "AND archived_at IS NULL",
                list(id_map.keys()),
            )
            new_note_ids: list[str] = []
            for n in notes:
                nr = await _copy_note_row(
                    conn, n, project_id, id_map[str(n["folder_id"])], user_id
                )
                new_note_ids.append(str(nr["id"]))
    for nid in new_note_ids:  # index the copies (after commit)
        await enqueue_embed(nid)
    return _folder(new_root)


async def move_folder(
    folder_id: str, target_project_id: str, parent_id: str | None, user_id: str
) -> Folder | None:
    """Move a folder under parent_id (NULL = target project root). Within the
    same project it just re-nests (with cycle protection). Across projects it
    reassigns the whole subtree — folders + their notes — to target_project_id,
    re-slugging each note and reconciling links (both are per-project), the same
    way move_note does for a single note. Returns None on not-found, a target
    parent in the wrong project, or a cycle (parent is the folder / a descendant).
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            folder = await conn.fetchrow(
                "SELECT * FROM folders WHERE id = $1::uuid AND archived_at IS NULL",
                folder_id,
            )
            if folder is None:
                return None
            src_project = str(folder["project_id"])
            target_project_id = str(target_project_id)

            if parent_id is not None:
                if parent_id == folder_id:
                    return None
                parent = await conn.fetchrow(
                    "SELECT project_id FROM folders "
                    "WHERE id = $1::uuid AND archived_at IS NULL",
                    parent_id,
                )
                if parent is None or str(parent["project_id"]) != target_project_id:
                    return None

            if target_project_id == src_project:
                # Same project — just re-nest, guarding against cycles.
                if parent_id is not None:
                    cycle = await conn.fetchval(
                        _SUBTREE_CTE + "SELECT 1 FROM subtree WHERE id = $2::uuid",
                        folder_id, parent_id,
                    )
                    if cycle:
                        return None
                row = await conn.fetchrow(
                    "UPDATE folders SET parent_id = $2::uuid, updated_at = now() "
                    "WHERE id = $1::uuid RETURNING *",
                    folder_id, parent_id,
                )
                return _folder(row)

            # Cross-project: move the whole subtree, then fix up each note.
            sub = await conn.fetch(_SUBTREE_CTE + "SELECT id FROM subtree", folder_id)
            folder_ids = [str(r["id"]) for r in sub]
            notes = await conn.fetch(
                "SELECT * FROM notes WHERE folder_id = ANY($1::uuid[]) "
                "AND archived_at IS NULL",
                folder_ids,
            )
            await conn.execute(
                "UPDATE folders SET project_id = $2::uuid, updated_at = now() "
                "WHERE id = ANY($1::uuid[])",
                folder_ids, target_project_id,
            )
            row = await conn.fetchrow(
                "UPDATE folders SET parent_id = $2::uuid, updated_at = now() "
                "WHERE id = $1::uuid RETURNING *",
                folder_id, parent_id,
            )
            for n in notes:
                nid = str(n["id"])
                slug = await _unique_slug(conn, target_project_id, n["slug"])
                await conn.execute(
                    "UPDATE notes SET project_id = $2::uuid, slug = $3, "
                    "updated_by = $4::uuid, updated_via = $5, updated_at = now() "
                    "WHERE id = $1::uuid",
                    nid, target_project_id, slug, user_id, _via(),
                )
                # Links from the old project can no longer resolve to this note.
                await conn.execute(
                    "UPDATE note_links SET target_note_id = NULL "
                    "WHERE target_note_id = $1::uuid AND source_note_id IN "
                    "(SELECT id FROM notes WHERE project_id = $2::uuid)",
                    nid, src_project,
                )
                await _sync_links(conn, nid, target_project_id, extract_wikilinks(n["body"]))
                await _resolve_incoming(conn, target_project_id, nid, n["title"])
    return _folder(row)


# ── Notes ───────────────────────────────────────────────────


@dataclass
class Note:
    id: str
    project_id: str
    folder_id: str | None
    title: str
    slug: str
    body: str
    type: str | None
    tags: list[str]
    status: str | None
    metadata: dict
    created_at: str
    updated_at: str
    # {id, name} provenance, populated only when the read query joined users
    # (i.e. get_note); write paths that RETURNING * leave these None.
    created_by: dict | None = None
    updated_by: dict | None = None
    # MCP client attribution (self-reported clientInfo.name); None = web UI.
    created_via: str | None = None
    updated_via: str | None = None


def _actor(row, id_col: str, name_col: str, upn_col: str) -> dict | None:
    """Resolve a created_by/updated_by user id to {id, name} when the read query
    joined `users` (so `name_col` is present). display_name is nullable, so fall
    back to the upn. Absent join columns → None (write paths don't join)."""
    if name_col not in row or row[id_col] is None:
        return None
    return {"id": str(row[id_col]), "name": row[name_col] or row[upn_col] or "Unknown"}


def _note(row) -> Note:
    md = row["metadata"]
    metadata = json.loads(md) if isinstance(md, str) else (md or {})
    return Note(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        folder_id=str(row["folder_id"]) if row["folder_id"] else None,
        title=row["title"],
        slug=row["slug"],
        body=row["body"],
        type=row["type"],
        tags=list(row["tags"]),
        status=row["status"],
        metadata=metadata,
        created_at=row["created_at"].isoformat(),
        updated_at=row["updated_at"].isoformat(),
        created_by=_actor(row, "created_by", "creator_name", "creator_upn"),
        updated_by=_actor(row, "updated_by", "editor_name", "editor_upn"),
        created_via=row["created_via"] if "created_via" in row.keys() else None,
        updated_via=row["updated_via"] if "updated_via" in row.keys() else None,
    )


async def _unique_slug(conn, project_id: str, base: str) -> str:
    slug, i = base, 2
    while await conn.fetchrow(
        "SELECT 1 FROM notes WHERE project_id = $1::uuid AND slug = $2", project_id, slug
    ):
        slug, i = f"{base}-{i}", i + 1
    return slug


async def _sync_links(conn, note_id, project_id: str, titles: list[str]) -> None:
    """Rewrite this note's outgoing links from its `[[wikilinks]]`."""
    await conn.execute("DELETE FROM note_links WHERE source_note_id = $1::uuid", note_id)
    for title in titles:
        target = await conn.fetchrow(
            "SELECT id FROM notes WHERE project_id = $1::uuid "
            "AND (slug = $2 OR lower(title) = lower($3)) LIMIT 1",
            project_id, slugify(title), title,
        )
        await conn.execute(
            "INSERT INTO note_links (source_note_id, target_note_id, target_title) "
            "VALUES ($1::uuid, $2, $3) "
            "ON CONFLICT (source_note_id, target_title) "
            "DO UPDATE SET target_note_id = EXCLUDED.target_note_id",
            note_id, target["id"] if target else None, title,
        )


async def _resolve_incoming(conn, project_id: str, note_id, title: str) -> None:
    """Point previously-unresolved links at this note (created after them)."""
    await conn.execute(
        "UPDATE note_links SET target_note_id = $1::uuid "
        "WHERE target_note_id IS NULL AND lower(target_title) = lower($2) "
        "AND source_note_id IN (SELECT id FROM notes WHERE project_id = $3::uuid)",
        note_id, title, project_id,
    )


async def create_note(
    project_id: str, title: str, body: str, user_id: str, folder_id: str | None = None
) -> Note:
    proj = project_metadata(parse_frontmatter(body)[0])
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            slug = await _unique_slug(conn, project_id, slugify(title))
            row = await conn.fetchrow(
                "INSERT INTO notes "
                "(project_id, folder_id, title, slug, body, type, tags, status, metadata, created_by, updated_by, created_via, updated_via) "
                "VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid,$10::uuid,$11,$11) RETURNING *",
                project_id, folder_id, title, slug, body, proj["type"], proj["tags"],
                proj["status"], json.dumps(proj["metadata"]), user_id, _via(),
            )
            await _sync_links(conn, row["id"], project_id, extract_wikilinks(body))
            await _resolve_incoming(conn, project_id, row["id"], title)
    note = _note(row)
    await enqueue_embed(note.id)  # index for semantic search (after commit)
    return note


def _dumps_metadata(md) -> str:
    """asyncpg returns JSONB as a str; normalize either form to a JSON string."""
    return md if isinstance(md, str) else json.dumps(md or {})


async def _copy_note_row(conn, src, project_id: str, folder_id: str | None, user_id: str,
                         title: str | None = None):
    """Insert a duplicate of `src` (a notes row) into project_id/folder_id."""
    new_title = title if title is not None else src["title"]
    slug = await _unique_slug(conn, project_id, slugify(new_title))
    row = await conn.fetchrow(
        "INSERT INTO notes "
        "(project_id, folder_id, title, slug, body, type, tags, status, metadata, created_by, updated_by, created_via, updated_via) "
        "VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid,$10::uuid,$11,$11) RETURNING *",
        project_id, folder_id, new_title, slug, src["body"], src["type"],
        list(src["tags"]), src["status"], _dumps_metadata(src["metadata"]), user_id, _via(),
    )
    await _sync_links(conn, row["id"], project_id, extract_wikilinks(src["body"]))
    return row


async def copy_note(note_id: str, user_id: str) -> Note | None:
    """Duplicate a note in place ('… (copy)'), same project + folder."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            src = await conn.fetchrow(
                "SELECT * FROM notes WHERE id = $1::uuid AND archived_at IS NULL", note_id
            )
            if src is None:
                return None
            row = await _copy_note_row(
                conn, src, str(src["project_id"]),
                str(src["folder_id"]) if src["folder_id"] else None,
                user_id, title=f"{src['title']} (copy)",
            )
    note = _note(row)
    await enqueue_embed(note.id)
    return note


async def archive_note(note_id: str, user_id: str) -> bool:
    """Soft-delete a note (recoverable via archived_at)."""
    pool = await get_pool()
    kept = await pool.fetchval(
        "UPDATE notes SET archived_at = now(), updated_by = $2::uuid, updated_via = $3 "
        "WHERE id = $1::uuid AND archived_at IS NULL RETURNING id",
        note_id, user_id, _via(),
    )
    return kept is not None


# ── Trash: restore / purge of archived items ────────────────

async def note_project(note_id: str) -> str | None:
    """A note's project id regardless of archived state — the Trash routes need
    it for the permission check (get_note filters archived rows out)."""
    pool = await get_pool()
    pid = await pool.fetchval("SELECT project_id FROM notes WHERE id = $1::uuid", note_id)
    return str(pid) if pid else None


async def folder_project(folder_id: str) -> str | None:
    """A folder's project id regardless of archived state (see note_project)."""
    pool = await get_pool()
    pid = await pool.fetchval("SELECT project_id FROM folders WHERE id = $1::uuid", folder_id)
    return str(pid) if pid else None


# Deletes are soft — archived_at is stamped now() atomically per operation, so
# every row deleted together shares the exact same timestamp. That shared
# timestamp is the "batch" key: restoring a folder brings back exactly the
# subtree deleted with it, leaving items trashed separately earlier untouched.

async def list_trash(user_id: str) -> dict:
    """Top-level restorable items for the caller: archived workspaces they own,
    plus the delete-roots (folders/notes whose parent isn't also archived) in
    live workspaces where they're owner/editor. Cascade children are hidden —
    restoring the root brings them back."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        projects = await conn.fetch(
            """
            SELECT p.id, p.name, p.archived_at
            FROM projects p
            JOIN project_members m ON m.project_id = p.id
            WHERE p.archived_at IS NOT NULL
              AND m.user_id = $1::uuid AND m.role = 'owner'
            ORDER BY p.archived_at DESC
            """,
            user_id,
        )
        folders = await conn.fetch(
            """
            SELECT f.id, f.name, f.project_id, p.name AS project_name, f.archived_at
            FROM folders f
            JOIN projects p ON p.id = f.project_id
            JOIN project_members m ON m.project_id = f.project_id
            WHERE f.archived_at IS NOT NULL AND p.archived_at IS NULL
              AND m.user_id = $1::uuid AND m.role IN ('owner', 'editor')
              AND (f.parent_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM folders pf
                   WHERE pf.id = f.parent_id AND pf.archived_at IS NOT NULL))
            ORDER BY f.archived_at DESC
            """,
            user_id,
        )
        notes = await conn.fetch(
            """
            SELECT n.id, n.title, n.project_id, p.name AS project_name, n.archived_at
            FROM notes n
            JOIN projects p ON p.id = n.project_id
            JOIN project_members m ON m.project_id = n.project_id
            WHERE n.archived_at IS NOT NULL AND p.archived_at IS NULL
              AND m.user_id = $1::uuid AND m.role IN ('owner', 'editor')
              AND (n.folder_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM folders f
                   WHERE f.id = n.folder_id AND f.archived_at IS NOT NULL))
            ORDER BY n.archived_at DESC
            """,
            user_id,
        )
    return {
        "projects": [
            {
                "type": "project",
                "id": str(r["id"]),
                "label": r["name"],
                "archived_at": r["archived_at"].isoformat(),
            }
            for r in projects
        ],
        "folders": [
            {
                "type": "folder",
                "id": str(r["id"]),
                "label": r["name"],
                "project_id": str(r["project_id"]),
                "project_name": r["project_name"],
                "archived_at": r["archived_at"].isoformat(),
            }
            for r in folders
        ],
        "notes": [
            {
                "type": "note",
                "id": str(r["id"]),
                "label": r["title"] or "Untitled",
                "project_id": str(r["project_id"]),
                "project_name": r["project_name"],
                "archived_at": r["archived_at"].isoformat(),
            }
            for r in notes
        ],
    }


async def restore_note(note_id: str) -> bool:
    """Un-archive a single note, dropping it to the workspace root if its folder
    is gone/archived. No-op if it isn't archived or its workspace is archived
    (restore the workspace first)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT n.folder_id, p.archived_at AS proj_archived,
                   f.archived_at AS folder_archived
            FROM notes n
            JOIN projects p ON p.id = n.project_id
            LEFT JOIN folders f ON f.id = n.folder_id
            WHERE n.id = $1::uuid AND n.archived_at IS NOT NULL
            """,
            note_id,
        )
        if row is None or row["proj_archived"] is not None:
            return False
        drop_to_root = row["folder_id"] is None or row["folder_archived"] is not None
        new_folder = None if drop_to_root else row["folder_id"]
        await conn.execute(
            "UPDATE notes SET archived_at = NULL, folder_id = $2 WHERE id = $1::uuid",
            note_id, new_folder,
        )
    return True


async def restore_folder(folder_id: str) -> bool:
    """Un-archive a folder and the subtree deleted with it (rows sharing its
    archived_at batch), reparenting to the workspace root if the original parent
    is gone/archived. No-op if it isn't archived or its workspace is archived."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT f.archived_at AS ts, f.parent_id,
                       p.archived_at AS proj_archived, pf.archived_at AS parent_archived
                FROM folders f
                JOIN projects p ON p.id = f.project_id
                LEFT JOIN folders pf ON pf.id = f.parent_id
                WHERE f.id = $1::uuid AND f.archived_at IS NOT NULL
                """,
                folder_id,
            )
            if row is None or row["proj_archived"] is not None:
                return False
            ts = row["ts"]
            if row["parent_id"] is None or row["parent_archived"] is not None:
                await conn.execute(
                    "UPDATE folders SET parent_id = NULL WHERE id = $1::uuid", folder_id
                )
            rows = await conn.fetch(
                """
                WITH RECURSIVE subtree AS (
                    SELECT id FROM folders WHERE id = $1::uuid
                    UNION ALL
                    SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
                    WHERE f.archived_at = $2
                )
                SELECT id FROM subtree
                """,
                folder_id, ts,
            )
            ids = [r["id"] for r in rows]
            await conn.execute(
                "UPDATE folders SET archived_at = NULL WHERE id = ANY($1::uuid[])", ids
            )
            await conn.execute(
                "UPDATE notes SET archived_at = NULL "
                "WHERE archived_at = $1 AND folder_id = ANY($2::uuid[])",
                ts, ids,
            )
    return True


async def restore_project(project_id: str) -> bool:
    """Un-archive a workspace. Its folders/notes were only hidden (archive
    doesn't stamp them), so they reappear; items trashed individually keep their
    own archived_at and stay in Trash."""
    pool = await get_pool()
    kept = await pool.fetchval(
        "UPDATE projects SET archived_at = NULL "
        "WHERE id = $1::uuid AND archived_at IS NOT NULL RETURNING id",
        project_id,
    )
    return kept is not None


async def purge_note(note_id: str) -> bool:
    """Permanently delete an archived note (revisions + link edges cascade)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT 1 FROM notes WHERE id = $1::uuid AND archived_at IS NOT NULL",
                note_id,
            )
            if not exists:
                return False
            await conn.execute(
                "DELETE FROM favorites WHERE item_type = 'note' AND item_id = $1::uuid",
                note_id,
            )
            await conn.execute("DELETE FROM notes WHERE id = $1::uuid", note_id)
    return True


async def purge_folder(folder_id: str) -> bool:
    """Permanently delete an archived folder and everything under it."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT archived_at FROM folders "
                "WHERE id = $1::uuid AND archived_at IS NOT NULL",
                folder_id,
            )
            if row is None:
                return False
            rows = await conn.fetch(
                """
                WITH RECURSIVE subtree AS (
                    SELECT id FROM folders WHERE id = $1::uuid
                    UNION ALL
                    SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
                    WHERE f.archived_at = $2
                )
                SELECT id FROM subtree
                """,
                folder_id, row["archived_at"],
            )
            fids = [r["id"] for r in rows]
            note_rows = await conn.fetch(
                "SELECT id FROM notes WHERE folder_id = ANY($1::uuid[])", fids
            )
            nids = [r["id"] for r in note_rows]
            if nids:
                await conn.execute(
                    "DELETE FROM favorites WHERE item_type = 'note' AND item_id = ANY($1::uuid[])",
                    nids,
                )
            await conn.execute(
                "DELETE FROM favorites WHERE item_type = 'folder' AND item_id = ANY($1::uuid[])",
                fids,
            )
            await conn.execute("DELETE FROM notes WHERE folder_id = ANY($1::uuid[])", fids)
            # folder→folder parent_id CASCADE removes any descendants too.
            await conn.execute("DELETE FROM folders WHERE id = ANY($1::uuid[])", fids)
    return True


async def purge_project(project_id: str) -> bool:
    """Permanently delete an archived workspace. The projects FK cascade removes
    its folders, notes, members, pins and invitations."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT 1 FROM projects WHERE id = $1::uuid AND archived_at IS NOT NULL",
                project_id,
            )
            if not exists:
                return False
            nids = [
                r["id"]
                for r in await conn.fetch(
                    "SELECT id FROM notes WHERE project_id = $1::uuid", project_id
                )
            ]
            fids = [
                r["id"]
                for r in await conn.fetch(
                    "SELECT id FROM folders WHERE project_id = $1::uuid", project_id
                )
            ]
            if nids:
                await conn.execute(
                    "DELETE FROM favorites WHERE item_type = 'note' AND item_id = ANY($1::uuid[])",
                    nids,
                )
            if fids:
                await conn.execute(
                    "DELETE FROM favorites WHERE item_type = 'folder' AND item_id = ANY($1::uuid[])",
                    fids,
                )
            await conn.execute(
                "DELETE FROM favorites WHERE item_type = 'project' AND item_id = $1::uuid",
                project_id,
            )
            await conn.execute("DELETE FROM projects WHERE id = $1::uuid", project_id)
    return True


async def purge_expired(retention_days: int) -> int:
    """Hard-delete everything archived longer ago than `retention_days`. Returns
    the count of top-level rows removed. Driven by the auto-purge periodic task;
    a no-op is expected most days."""
    if retention_days <= 0:
        return 0
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            age = "now() - ($1::int * interval '1 day')"
            # Workspaces first — their cascade clears contained folders/notes.
            proj = await conn.fetch(
                f"DELETE FROM projects WHERE archived_at < {age} RETURNING id",
                retention_days,
            )
            notes = await conn.fetch(
                f"DELETE FROM notes WHERE archived_at < {age} RETURNING id",
                retention_days,
            )
            folders = await conn.fetch(
                f"DELETE FROM folders WHERE archived_at < {age} RETURNING id",
                retention_days,
            )
            # Clear favorites orphaned by any of the deletes above.
            await conn.execute(
                """
                DELETE FROM favorites f WHERE
                  (f.item_type = 'note'    AND NOT EXISTS (SELECT 1 FROM notes n    WHERE n.id = f.item_id)) OR
                  (f.item_type = 'folder'  AND NOT EXISTS (SELECT 1 FROM folders fo WHERE fo.id = f.item_id)) OR
                  (f.item_type = 'project' AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = f.item_id))
                """
            )
    return len(proj) + len(notes) + len(folders)


class StaleUpdate(Exception):
    """The caller's base version no longer matches the stored note — someone
    else saved in between. Surfaced as a 409 so the client can reconcile
    instead of silently overwriting the other edit."""


async def _write_note_edit(conn, cur_row, new_title: str, new_body: str, user_id: str):
    """Canonical single-note write, run on the caller's connection so it stays
    in their transaction. Used for both a plain edit and each rename-cascade
    linker so they get identical treatment: snapshot the prior body (throttled)
    when it changed, reproject frontmatter → hot columns, stamp attribution +
    bump updated_at, and re-sync outgoing links. No embedding — callers decide.
    Returns the updated row (RETURNING *)."""
    if new_body != cur_row["body"]:
        await _maybe_snapshot_prior(conn, cur_row)
    proj = project_metadata(parse_frontmatter(new_body)[0])
    row = await conn.fetchrow(
        "UPDATE notes SET title=$2, body=$3, type=$4, tags=$5, status=$6, "
        "metadata=$7::jsonb, updated_by=$8::uuid, updated_via=$9, updated_at=now() "
        "WHERE id=$1::uuid RETURNING *",
        cur_row["id"], new_title, new_body, proj["type"], proj["tags"],
        proj["status"], json.dumps(proj["metadata"]), user_id, _via(),
    )
    await _sync_links(conn, cur_row["id"], str(cur_row["project_id"]),
                      extract_wikilinks(new_body))
    return row


async def update_note(
    note_id: str,
    title: str | None,
    body: str | None,
    user_id: str,
    base_updated_at: str | None = None,
) -> Note | None:
    """Persist a note edit. When `base_updated_at` is given (the `updated_at`
    the client last loaded), we refuse the write with `StaleUpdate` if the row
    has moved since — optimistic concurrency, no locking. Omitting it keeps the
    old last-writer-wins behaviour (used by best-effort flushes and renames)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            cur = await conn.fetchrow("SELECT * FROM notes WHERE id = $1::uuid", note_id)
            if cur is None:
                return None
            if base_updated_at is not None and cur["updated_at"].isoformat() != base_updated_at:
                raise StaleUpdate()
            new_title = title if title is not None else cur["title"]
            new_body = body if body is not None else cur["body"]
            pid = str(cur["project_id"])
            renamed = new_title != cur["title"]
            # Rename cascade: inbound `[[old title]]` TEXT in same-project notes
            # keeps naming this note by its old title. The id-edge itself
            # survives (resolution falls back to the immutable slug), but the
            # reading view renders the stale literal text — and when this
            # note's slug doesn't match slugify(old title) (duplicate-title
            # disambiguation, prior renames) the edge really does rot on the
            # linker's next save. Rewrite the link text in-txn with the rename,
            # using the SAME canonical write as any edit.
            #
            # Guards — the rename always lands, only the rewrite is skipped:
            # · blank titles can't round-trip inside `[[...]]`;
            # · UNSAFE_WIKILINK_TITLE_CHARS would re-parse as link syntax;
            # · collision: if ANOTHER note already answers to new_title (by
            #   slug or title — mirroring _sync_links resolution, which does
            #   NOT filter archived), a rewritten `[[new title]]` could
            #   re-resolve to that note instead. Old text keeps resolving here
            #   via the slug, so skipping is strictly safer.
            cascade = bool(
                renamed
                and cur["title"].strip() and new_title.strip()
                and not (set(new_title) & UNSAFE_WIKILINK_TITLE_CHARS)
                and not await conn.fetchval(
                    "SELECT 1 FROM notes WHERE project_id = $1::uuid AND id <> $2::uuid "
                    "AND (slug = $3 OR lower(title) = lower($4)) LIMIT 1",
                    pid, note_id, slugify(new_title), new_title,
                )
            )
            if cascade:
                # Self-links: rewrite this note's own body BEFORE the primary
                # write so the returned row (and its updated_at — the client's
                # next concurrency token) reflects the final text. Only when the
                # self-edge actually resolves here — a `[[old title]]` pointing
                # at a duplicate-titled sibling is that note's business.
                self_edge = await conn.fetchval(
                    "SELECT 1 FROM note_links WHERE source_note_id = $1::uuid "
                    "AND target_note_id = $1::uuid AND lower(target_title) = lower($2)",
                    note_id, cur["title"],
                )
                if self_edge:
                    new_body, _ = rewrite_wikilink_target(new_body, cur["title"], new_title)
            row = await _write_note_edit(conn, cur, new_title, new_body, user_id)
            if cascade:
                # Match linkers by the RESOLVED edge (target_note_id == THIS
                # note), not by old-title text: titles aren't unique (only slug
                # is), so a title match could clobber a *different* note that
                # happens to share the old title. Fetch full rows in one query
                # (no per-linker SELECT — the helper needs the whole row).
                #
                # FOR UPDATE is load-bearing, not an optimisation: without it a
                # concurrent save to a linker that COMMITS between this SELECT
                # and our UPDATE would be read stale and silently overwritten
                # with a rewrite of the pre-save body — an unrecoverable lost
                # update (the snapshot would capture the same stale body). The
                # lock makes us block on, then read, the committed version; a
                # client that loaded the linker earlier then hits StaleUpdate on
                # its own save (409) instead of losing data. ORDER BY id gives a
                # deterministic lock order so renames sharing linkers can't
                # deadlock against each other (two renames of mutually-linked
                # notes still can — rare, and Postgres aborts one cleanly).
                linkers = await conn.fetch(
                    "SELECT * FROM notes WHERE project_id = $2::uuid AND archived_at IS NULL "
                    "AND id <> $1::uuid AND id IN "
                    "(SELECT source_note_id FROM note_links WHERE target_note_id = $1::uuid) "
                    "ORDER BY id FOR UPDATE",
                    note_id, pid,
                )
                for lr in linkers:
                    new_lbody, n = rewrite_wikilink_target(lr["body"], cur["title"], new_title)
                    if n == 0:
                        continue  # e.g. links via slug text or inside code — nothing to rewrite
                    # Title unchanged for the linker — only its body. No re-embed
                    # — a mechanical `[[old]]→[[new]]` swap isn't a meaningful
                    # semantic change.
                    await _write_note_edit(conn, lr, lr["title"], new_lbody, user_id)
            if renamed:
                # Claim dangling links that already say `[[new title]]` — the
                # same adoption create/move do. Independent of the cascade
                # guards: it rewrites no text, just resolves existing edges.
                await _resolve_incoming(conn, pid, note_id, new_title)
    note = _note(row)
    # Re-index only when something that affects the embedding actually changed.
    if renamed or new_body != cur["body"]:
        await enqueue_embed(note.id)
    return note


async def move_note(
    note_id: str, target_project_id: str, target_folder_id: str | None, user_id: str
) -> Note | None:
    """Move a note to a folder (target_folder_id, NULL = project root), possibly
    in another project. Within the same project only folder_id changes. Across
    projects we also reslug + reconcile links (slugs/links are per-project): we
    unresolve links from the *old* project that pointed here, re-resolve this
    note's outgoing links against the *new* project, and claim any previously-
    dangling links there that name this note.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            cur = await conn.fetchrow(
                "SELECT * FROM notes WHERE id = $1::uuid AND archived_at IS NULL", note_id
            )
            if cur is None:
                return None
            src_project = str(cur["project_id"])
            if src_project == target_project_id:
                # Same project — only the folder changes.
                row = await conn.fetchrow(
                    "UPDATE notes SET folder_id = $2::uuid, "
                    "updated_by = $3::uuid, updated_via = $4, updated_at = now() "
                    "WHERE id = $1::uuid RETURNING *",
                    note_id, target_folder_id, user_id, _via(),
                )
                return _note(row)

            slug = await _unique_slug(conn, target_project_id, cur["slug"])
            row = await conn.fetchrow(
                "UPDATE notes SET project_id = $2::uuid, folder_id = $3::uuid, slug = $4, "
                "updated_by = $5::uuid, updated_via = $6, updated_at = now() "
                "WHERE id = $1::uuid RETURNING *",
                note_id, target_project_id, target_folder_id, slug, user_id, _via(),
            )
            # Links from the old project can no longer resolve to this note.
            await conn.execute(
                "UPDATE note_links SET target_note_id = NULL "
                "WHERE target_note_id = $1::uuid "
                "AND source_note_id IN (SELECT id FROM notes WHERE project_id = $2::uuid)",
                note_id, src_project,
            )
            await _sync_links(conn, note_id, target_project_id, extract_wikilinks(row["body"]))
            await _resolve_incoming(conn, target_project_id, note_id, row["title"])
    return _note(row)


async def get_note(note_id: str) -> Note | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT n.*, "
        "cu.display_name AS creator_name, cu.upn AS creator_upn, "
        "eu.display_name AS editor_name, eu.upn AS editor_upn "
        "FROM notes n "
        "LEFT JOIN users cu ON cu.id = n.created_by "
        "LEFT JOIN users eu ON eu.id = n.updated_by "
        "WHERE n.id = $1::uuid AND n.archived_at IS NULL",
        note_id,
    )
    return _note(row) if row else None


async def list_notes(project_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, title, slug, type, tags, status, folder_id, created_at, updated_at "
        "FROM notes WHERE project_id = $1::uuid AND archived_at IS NULL "
        "ORDER BY updated_at DESC",
        project_id,
    )
    return [
        {
            "id": str(r["id"]),
            "title": r["title"],
            "slug": r["slug"],
            "type": r["type"],
            "tags": list(r["tags"]),
            "status": r["status"],
            "folder_id": str(r["folder_id"]) if r["folder_id"] else None,
            "created_at": r["created_at"].isoformat(),
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


async def get_backlinks(note_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT n.id, n.title, n.slug FROM note_links l JOIN notes n ON n.id = l.source_note_id "
        "WHERE l.target_note_id = $1::uuid AND n.archived_at IS NULL ORDER BY n.title",
        note_id,
    )
    return [{"id": str(r["id"]), "title": r["title"], "slug": r["slug"]} for r in rows]


async def get_outbound_links(note_id: str) -> list[dict]:
    """This note's `[[wikilinks]]` as RESOLVED edges: raw target text → target
    note id (or null while dangling / target trashed). Exposed on the note read
    so clients resolve links by id — the body and its edges come from the same
    fetch and can't desync the way text-matching against a cached note list
    does (e.g. right after a rename)."""
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT l.target_title, n.id, n.title, n.slug "
        "FROM note_links l "
        "LEFT JOIN notes n ON n.id = l.target_note_id AND n.archived_at IS NULL "
        "WHERE l.source_note_id = $1::uuid",
        note_id,
    )
    return [
        {
            "target_title": r["target_title"],
            "id": str(r["id"]) if r["id"] else None,
            "title": r["title"],
            "slug": r["slug"],
        }
        for r in rows
    ]


# ── Version history (snapshots) ─────────────────────────────
# Full-body snapshots (not deltas); diffs are computed on view in the browser.
# Auto-snapshots are throttled to at most one per note per this window, so a
# long editing session (autosave every ~0.8s) leaves periodic checkpoints
# instead of a row per keystroke-batch.
_SNAPSHOT_WINDOW = "10 minutes"

# Column aliases the revision queries expose so _actor can resolve the author.
_REV_AUTHOR_COLS = (
    "u.id AS author_id, u.display_name AS author_name, u.upn AS author_upn"
)


async def _snapshot(conn, note_id, body: str, author_id, trigger: str,
                    label: str | None = None, client: str | None = None) -> None:
    await conn.execute(
        "INSERT INTO note_revisions (note_id, body, author_id, trigger, label, client) "
        "VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6)",
        note_id, body, author_id, trigger, label, client,
    )


async def _maybe_snapshot_prior(conn, cur_row) -> None:
    """Checkpoint a note's *prior* body before it's overwritten, unless a
    snapshot already exists within _SNAPSHOT_WINDOW (throttle). Credited to
    whoever authored that prior body (cur_row['updated_by']), via whichever
    client wrote it (cur_row['updated_via'])."""
    recent = await conn.fetchval(
        "SELECT 1 FROM note_revisions WHERE note_id = $1::uuid "
        f"AND created_at > now() - interval '{_SNAPSHOT_WINDOW}' LIMIT 1",
        cur_row["id"],
    )
    if not recent:
        await _snapshot(conn, cur_row["id"], cur_row["body"], cur_row["updated_by"],
                        "auto", client=cur_row["updated_via"])


def _revision(row, *, with_body: bool) -> dict:
    rev = {
        "id": str(row["id"]),
        "trigger": row["trigger"],
        "label": row["label"],
        "created_at": row["created_at"].isoformat(),
        "author": _actor(row, "author_id", "author_name", "author_upn"),
        # MCP client that wrote this body (self-reported); None = web UI.
        "client": row["client"],
    }
    if with_body:
        rev["body"] = row["body"]
    return rev


async def list_revisions(note_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        f"SELECT r.id, r.trigger, r.label, r.created_at, r.client, {_REV_AUTHOR_COLS} "
        "FROM note_revisions r LEFT JOIN users u ON u.id = r.author_id "
        "WHERE r.note_id = $1::uuid ORDER BY r.created_at DESC",
        note_id,
    )
    return [_revision(r, with_body=False) for r in rows]


async def get_revision(note_id: str, rev_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        f"SELECT r.id, r.body, r.trigger, r.label, r.created_at, r.client, {_REV_AUTHOR_COLS} "
        "FROM note_revisions r LEFT JOIN users u ON u.id = r.author_id "
        "WHERE r.id = $1::uuid AND r.note_id = $2::uuid",
        rev_id, note_id,
    )
    return _revision(row, with_body=True) if row else None


async def create_revision(note_id: str, user_id: str, label: str | None = None) -> bool:
    """Manual 'Save version': snapshot the note's *current* body as a labeled
    checkpoint. Returns False if the note is gone."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        note = await conn.fetchrow(
            "SELECT body FROM notes WHERE id = $1::uuid AND archived_at IS NULL", note_id
        )
        if note is None:
            return False
        await _snapshot(conn, note_id, note["body"], user_id, "manual", label,
                        client=_via())
    return True


async def restore_revision(note_id: str, rev_id: str, user_id: str) -> Note | None:
    """Non-destructive restore: force-checkpoint the current body (so it's
    recoverable even inside the throttle window), then write the revision's body
    back as current via update_note (which reprojects metadata + relinks)."""
    pool = await get_pool()
    rev = await pool.fetchrow(
        "SELECT body FROM note_revisions WHERE id = $1::uuid AND note_id = $2::uuid",
        rev_id, note_id,
    )
    cur = await pool.fetchrow(
        "SELECT body, updated_by, updated_via FROM notes "
        "WHERE id = $1::uuid AND archived_at IS NULL",
        note_id,
    )
    if rev is None or cur is None:
        return None
    if rev["body"] != cur["body"]:
        await _snapshot(pool, note_id, cur["body"], cur["updated_by"], "auto",
                        client=cur["updated_via"])
    # update_note's throttle sees the checkpoint above and won't double-snapshot.
    return await update_note(note_id, None, rev["body"], user_id)


# Hybrid search: fuse a keyword (full-text) candidate list and a semantic
# (pgvector cosine) candidate list with Reciprocal Rank Fusion (RRF). RRF needs
# no score normalization — it combines *ranks*, sidestepping the scale mismatch
# between ts_rank and cosine similarity — then a gentle recency factor breaks
# ties toward fresher notes. Both lists are scoped to the caller's memberships
# (and an optional single project). The semantic list is empty when $3 is NULL
# (query embedding unavailable) or a note has no vector yet, so search degrades
# cleanly to keyword-only. $1=user_id $2=query $3=query_vector $4=project scope
# (NULL=all) $5=limit.
_RRF_K = 60
_SEARCH_SQL = f"""
WITH me AS (
    SELECT project_id FROM project_members WHERE user_id = $1::uuid
    UNION
    SELECT id FROM projects WHERE org_access = 'viewer' AND archived_at IS NULL
),
scoped AS (
    SELECT n.id, n.search_tsv, n.embedding
    FROM notes n
    WHERE n.project_id IN (SELECT project_id FROM me)
      AND ($4::uuid IS NULL OR n.project_id = $4::uuid)
      AND n.archived_at IS NULL
),
kw AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY rank DESC) AS rnk FROM (
        SELECT id, ts_rank_cd(search_tsv, websearch_to_tsquery('english', $2)) AS rank
        FROM scoped
        WHERE search_tsv @@ websearch_to_tsquery('english', $2)
        ORDER BY rank DESC
        LIMIT 50
    ) k
),
sem AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY dist ASC) AS rnk FROM (
        SELECT id, embedding <=> $3::vector AS dist
        FROM scoped
        WHERE embedding IS NOT NULL AND $3::vector IS NOT NULL
        ORDER BY dist ASC
        LIMIT 50
    ) s
),
fused AS (
    SELECT id, SUM(1.0 / ({_RRF_K} + rnk)) AS score
    FROM (SELECT id, rnk FROM kw UNION ALL SELECT id, rnk FROM sem) u
    GROUP BY id
)
SELECT n.id, n.title, n.slug, n.project_id, p.name AS project_name,
       n.folder_id, n.body, n.updated_at,
       f.score * (1 + 0.1 / (1 + EXTRACT(EPOCH FROM (now() - n.updated_at)) / 86400 / 365))
           AS score
FROM fused f
JOIN notes n ON n.id = f.id
JOIN projects p ON p.id = n.project_id
ORDER BY score DESC
LIMIT $5
"""


async def search_notes(
    user_id: str,
    query: str,
    query_vector: list[float] | None,
    project_id: str | None,
    limit: int,
) -> list[dict]:
    """Hybrid keyword+semantic search across the caller's notes (see `_SEARCH_SQL`)."""
    pool = await get_pool()
    rows = await pool.fetch(
        _SEARCH_SQL,
        user_id,
        query,
        to_pgvector(query_vector) if query_vector else None,
        project_id,
        limit,
    )
    results = []
    for r in rows:
        _, content = parse_frontmatter(r["body"])
        snippet = " ".join(content.split())[:200]
        results.append(
            {
                "id": str(r["id"]),
                "title": r["title"],
                "slug": r["slug"],
                "project_id": str(r["project_id"]),
                "project_name": r["project_name"],
                "folder_id": str(r["folder_id"]) if r["folder_id"] else None,
                "snippet": snippet,
                "updated_at": r["updated_at"].isoformat(),
                "score": float(r["score"]),
            }
        )
    return results


async def get_graph(project_id: str) -> dict:
    """Nodes + edges for a project's knowledge graph.

    Nodes are the project's live notes; edges are `[[wikilinks]]` that resolved
    to another live note in the *same* project (unresolved links carry no edge).
    `folder_id`/`tags` are returned so the client can color/group; node sizing by
    degree is computed client-side to keep this query lean.
    """
    pool = await get_pool()
    nodes = await pool.fetch(
        "SELECT id, title, folder_id, tags FROM notes "
        "WHERE project_id = $1::uuid AND archived_at IS NULL",
        project_id,
    )
    links = await pool.fetch(
        "SELECT l.source_note_id AS source, l.target_note_id AS target "
        "FROM note_links l "
        "JOIN notes s ON s.id = l.source_note_id AND s.archived_at IS NULL "
        "JOIN notes t ON t.id = l.target_note_id AND t.archived_at IS NULL "
        "WHERE s.project_id = $1::uuid AND t.project_id = $1::uuid",
        project_id,
    )
    return {
        "nodes": [
            {
                "id": str(r["id"]),
                "title": r["title"],
                "folder_id": str(r["folder_id"]) if r["folder_id"] else None,
                "tags": list(r["tags"]),
            }
            for r in nodes
        ],
        "links": [
            {"source": str(r["source"]), "target": str(r["target"])} for r in links
        ],
    }


# ── MCP: link suggestions, structured query, tags, stats ────
# These serve MCP tools that the UI never needed. They reuse the same
# membership scoping (`me` CTE over project_members + org-viewer projects) and
# the pgvector `embedding` column that hybrid search already relies on.


async def suggest_links(note_id: str, limit: int = 8) -> list[dict]:
    """Semantically nearest notes to `note_id`, in the same project — link
    candidates for an assistant to propose. Excludes the note itself and notes it
    already links to. Returns [] when the note isn't embedded yet (links are
    per-project, so cross-project neighbors are intentionally not suggested)."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        WITH src AS (
            SELECT project_id, embedding FROM notes
            WHERE id = $1::uuid AND archived_at IS NULL
        )
        SELECT n.id, n.title, n.slug,
               1 - (n.embedding <=> (SELECT embedding FROM src)) AS score
        FROM notes n, src
        WHERE n.project_id = src.project_id
          AND n.id <> $1::uuid
          AND n.archived_at IS NULL
          AND n.embedding IS NOT NULL
          AND (SELECT embedding FROM src) IS NOT NULL
          AND n.id NOT IN (
              SELECT target_note_id FROM note_links
              WHERE source_note_id = $1::uuid AND target_note_id IS NOT NULL
          )
        ORDER BY n.embedding <=> (SELECT embedding FROM src)
        LIMIT $2
        """,
        note_id, limit,
    )
    return [
        {"id": str(r["id"]), "title": r["title"], "slug": r["slug"],
         "score": float(r["score"])}
        for r in rows
    ]


async def neighbors_for_text(
    project_id: str, query_vector: list[float] | None, exclude_id: str, limit: int = 8
) -> list[dict]:
    """Notes in `project_id` nearest to a supplied query vector, excluding
    `exclude_id`. Lets a just-written note surface link candidates immediately
    (its own stored embedding is computed asynchronously and isn't ready yet), by
    embedding its text on the fly. Returns [] when the vector is None."""
    if query_vector is None:
        return []
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, title, slug, 1 - (embedding <=> $2::vector) AS score "
        "FROM notes WHERE project_id = $1::uuid AND archived_at IS NULL "
        "AND embedding IS NOT NULL AND id <> $3::uuid "
        "ORDER BY embedding <=> $2::vector LIMIT $4",
        project_id, to_pgvector(query_vector), exclude_id, limit,
    )
    return [
        {"id": str(r["id"]), "title": r["title"], "slug": r["slug"],
         "score": float(r["score"])}
        for r in rows
    ]


async def query_notes(
    user_id: str,
    *,
    project_id: str | None = None,
    type: str | None = None,
    tags: list[str] | None = None,
    status: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Pure structured query over the caller's accessible notes (no ranking).
    Filters AND together; `tags` matches notes carrying ALL of the given tags."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        WITH me AS (
            SELECT project_id FROM project_members WHERE user_id = $1::uuid
            UNION
            SELECT id FROM projects WHERE org_access = 'viewer' AND archived_at IS NULL
        )
        SELECT n.id, n.title, n.slug, n.type, n.tags, n.status,
               n.project_id, p.name AS project_name, n.folder_id, n.updated_at
        FROM notes n
        JOIN projects p ON p.id = n.project_id
        WHERE n.project_id IN (SELECT project_id FROM me)
          AND ($2::uuid IS NULL OR n.project_id = $2::uuid)
          AND ($3::text IS NULL OR n.type = $3)
          AND ($4::text IS NULL OR n.status = $4)
          AND ($5::text[] IS NULL OR n.tags @> $5)
          AND n.archived_at IS NULL
        ORDER BY n.updated_at DESC
        LIMIT $6
        """,
        user_id, project_id, type, status, tags or None, limit,
    )
    return [
        {
            "id": str(r["id"]),
            "title": r["title"],
            "slug": r["slug"],
            "type": r["type"],
            "tags": list(r["tags"]),
            "status": r["status"],
            "project_id": str(r["project_id"]),
            "project_name": r["project_name"],
            "folder_id": str(r["folder_id"]) if r["folder_id"] else None,
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


async def list_tags(project_id: str) -> list[dict]:
    """Tags used in a project with note counts, most-used first."""
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT tag, COUNT(*) AS count FROM notes n, unnest(n.tags) AS tag "
        "WHERE n.project_id = $1::uuid AND n.archived_at IS NULL "
        "GROUP BY tag ORDER BY count DESC, tag",
        project_id,
    )
    return [{"tag": r["tag"], "count": int(r["count"])} for r in rows]


async def project_stats(project_id: str) -> dict:
    """Health counts for a project: live notes, resolved links, unresolved
    links, orphan notes (no resolved link in or out), and distinct tags."""
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        WITH live AS (
            SELECT id FROM notes WHERE project_id = $1::uuid AND archived_at IS NULL
        ),
        resolved AS (
            SELECT l.source_note_id AS s, l.target_note_id AS t
            FROM note_links l
            JOIN live sn ON sn.id = l.source_note_id
            JOIN live tn ON tn.id = l.target_note_id
        )
        SELECT
            (SELECT COUNT(*) FROM live) AS notes,
            (SELECT COUNT(*) FROM resolved) AS links,
            (SELECT COUNT(*) FROM note_links l
                JOIN live sn ON sn.id = l.source_note_id
                WHERE l.target_note_id IS NULL) AS unresolved_links,
            (SELECT COUNT(*) FROM live
                WHERE id NOT IN (SELECT s FROM resolved)
                  AND id NOT IN (SELECT t FROM resolved)) AS orphans,
            (SELECT COUNT(DISTINCT tag) FROM notes n, unnest(n.tags) AS tag
                WHERE n.project_id = $1::uuid AND n.archived_at IS NULL) AS tags
        """,
        project_id,
    )
    return {
        "notes": int(row["notes"]),
        "links": int(row["links"]),
        "unresolved_links": int(row["unresolved_links"]),
        "orphans": int(row["orphans"]),
        "tags": int(row["tags"]),
    }


# ── Export ──────────────────────────────────────────────────

# Characters not allowed (or unsafe) in file names across OSes.
_ILLEGAL_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _safe_filename(name: str) -> str:
    """A cross-platform-safe file/dir name from a title: strip illegal chars,
    collapse whitespace, no trailing dots (Windows)."""
    s = _ILLEGAL_FILENAME.sub("-", (name or "").strip())
    s = re.sub(r"\s+", " ", s).strip().rstrip(".")
    return s or "untitled"


async def get_export_tree(project_id: str, folder_id: str | None = None) -> dict:
    """Gather notes for a zip export as ``{"name", "items": [{"path","body"}]}``.

    ``folder_id=None`` exports the whole project; otherwise that folder's subtree.
    Paths are relative to the export root (the project or the folder), rebuilding
    the folder hierarchy as directories. Each note is ``<sanitized title>.md``,
    de-duplicated within its directory.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        if folder_id:
            root = await conn.fetchrow(
                "SELECT id, name FROM folders WHERE id = $1::uuid AND archived_at IS NULL",
                folder_id,
            )
            if root is None:
                return {"name": "export", "items": []}
            root_name = root["name"]
            root_id = str(folder_id)
            folder_rows = await conn.fetch(
                _SUBTREE_CTE + "SELECT id, parent_id, name FROM subtree", folder_id
            )
            note_rows = await conn.fetch(
                "SELECT folder_id, title, slug, body FROM notes "
                "WHERE folder_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY title",
                [r["id"] for r in folder_rows],
            )
        else:
            proj = await conn.fetchrow(
                "SELECT name FROM projects WHERE id = $1::uuid", project_id
            )
            root_name = proj["name"] if proj else "workspace"
            root_id = None
            folder_rows = await conn.fetch(
                "SELECT id, parent_id, name FROM folders "
                "WHERE project_id = $1::uuid AND archived_at IS NULL",
                project_id,
            )
            note_rows = await conn.fetch(
                "SELECT folder_id, title, slug, body FROM notes "
                "WHERE project_id = $1::uuid AND archived_at IS NULL ORDER BY title",
                project_id,
            )

    by_id = {str(r["id"]): r for r in folder_rows}

    # The directory path (list of sanitized folder names) for a note's folder,
    # walking parents up to — but not including — the export root.
    def dir_parts(fid) -> list[str]:
        parts: list[str] = []
        cur = str(fid) if fid else None
        while cur and cur in by_id and cur != root_id:
            parts.append(_safe_filename(by_id[cur]["name"]))
            cur = str(by_id[cur]["parent_id"]) if by_id[cur]["parent_id"] else None
        return list(reversed(parts))

    used: dict[str, set[str]] = {}
    items: list[dict] = []
    for n in note_rows:
        parts = dir_parts(n["folder_id"])
        base = _safe_filename(n["title"] or n["slug"])
        seen = used.setdefault("/".join(parts), set())
        name, i = base, 2
        while name.lower() in seen:
            name, i = f"{base} ({i})", i + 1
        seen.add(name.lower())
        items.append({"path": "/".join([*parts, name + ".md"]), "body": n["body"]})

    return {"name": _safe_filename(root_name), "items": items}


async def get_root_graph(user_id: str) -> dict:
    """Whole-account structure graph across every workspace the caller belongs to.

    Nodes are workspaces (projects), folders, and notes — each tagged with its
    `kind`. Edges are containment (workspace→folder→subfolder→note) plus resolved
    `[[wikilinks]]` between notes (`kind` "contains" vs "link"). Node ids are the
    raw row uuids (unique across tables), so a note node's id opens that note.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        projects = await conn.fetch(
            "SELECT p.id, p.name FROM projects p "
            "JOIN project_members m ON m.project_id = p.id "
            "WHERE m.user_id = $1::uuid AND p.archived_at IS NULL",
            user_id,
        )
        if not projects:
            return {"nodes": [], "links": []}
        pids = [r["id"] for r in projects]
        folders = await conn.fetch(
            "SELECT id, project_id, parent_id, name FROM folders "
            "WHERE project_id = ANY($1::uuid[]) AND archived_at IS NULL",
            pids,
        )
        notes = await conn.fetch(
            "SELECT id, project_id, folder_id, title FROM notes "
            "WHERE project_id = ANY($1::uuid[]) AND archived_at IS NULL",
            pids,
        )
        links = await conn.fetch(
            "SELECT l.source_note_id AS source, l.target_note_id AS target "
            "FROM note_links l "
            "JOIN notes s ON s.id = l.source_note_id AND s.archived_at IS NULL "
            "JOIN notes t ON t.id = l.target_note_id AND t.archived_at IS NULL "
            "WHERE s.project_id = ANY($1::uuid[]) AND t.project_id = ANY($1::uuid[])",
            pids,
        )

    nodes: list[dict] = []
    edges: list[dict] = []
    for r in projects:
        nodes.append({"id": str(r["id"]), "label": r["name"], "kind": "project"})
    for r in folders:
        fid = str(r["id"])
        nodes.append({"id": fid, "label": r["name"], "kind": "folder"})
        parent = str(r["parent_id"]) if r["parent_id"] else str(r["project_id"])
        edges.append({"source": parent, "target": fid, "kind": "contains"})
    for r in notes:
        nid = str(r["id"])
        nodes.append({"id": nid, "label": r["title"], "kind": "note"})
        parent = str(r["folder_id"]) if r["folder_id"] else str(r["project_id"])
        edges.append({"source": parent, "target": nid, "kind": "contains"})
    for r in links:
        edges.append(
            {"source": str(r["source"]), "target": str(r["target"]), "kind": "link"}
        )
    return {"nodes": nodes, "links": edges}
