"""Permission scoping / fail-closed — the "can't see or act on what you
shouldn't" invariant. Covers the single authorization chokepoint
(get_membership_role) and that the retrieval queries actually scope to it."""
from __future__ import annotations

from src import data
from src.tools._base import FORBIDDEN, NOT_FOUND


async def test_membership_role_none_for_non_member(make_user, make_project):
    owner = await make_user(name="Owner")
    outsider = await make_user(name="Outsider")
    proj = await make_project(owner)
    assert await data.get_membership_role(owner.id, proj.id) == "owner"
    # Fail-closed: someone with no membership row sees nothing.
    assert await data.get_membership_role(outsider.id, proj.id) is None


async def test_membership_role_reflects_role(make_user, make_project, add_member):
    owner = await make_user()
    editor = await make_user()
    viewer = await make_user()
    proj = await make_project(owner)
    await add_member(proj, editor, "editor")
    await add_member(proj, viewer, "viewer")
    assert await data.get_membership_role(editor.id, proj.id) == "editor"
    assert await data.get_membership_role(viewer.id, proj.id) == "viewer"


async def test_org_visible_project_grants_viewer_to_non_member(
    make_user, make_project
):
    owner = await make_user()
    anyone = await make_user()
    proj = await make_project(owner)
    assert await data.get_membership_role(anyone.id, proj.id) is None
    await data.set_org_access(proj.id, "viewer")
    # Org-visible workspaces grant an effective 'viewer' to any org user.
    assert await data.get_membership_role(anyone.id, proj.id) == "viewer"


async def test_search_does_not_cross_project_boundaries(
    make_user, make_project, make_note
):
    x = await make_user(name="X")
    y = await make_user(name="Y")
    px = await make_project(x, name="X-space")
    py = await make_project(y, name="Y-space")
    mine = await make_note(px, title="Mine", body="shared keyword aardvark here")
    await make_note(py, title="Theirs", body="shared keyword aardvark here")

    # qvec=None ⇒ keyword-only; both notes match, but X may only see their own.
    results = await data.search_notes(x.id, "aardvark", None, None, 20)
    ids = {r["id"] for r in results}
    assert mine.id in ids
    assert len(ids) == 1, "search leaked a note from a project X isn't a member of"


async def test_query_notes_does_not_cross_project_boundaries(
    make_user, make_project, make_note
):
    x = await make_user(name="X")
    y = await make_user(name="Y")
    px = await make_project(x)
    py = await make_project(y)
    mine = await make_note(px, title="Mine", body="---\ntype: task\n---\nbody")
    await make_note(py, title="Theirs", body="---\ntype: task\n---\nbody")

    notes = await data.query_notes(x.id, type="task")
    ids = {n["id"] for n in notes}
    assert ids == {mine.id}


async def test_query_notes_project_scope_filter(
    make_user, make_project, make_note, add_member
):
    x = await make_user()
    p1 = await make_project(x, name="One")
    p2 = await make_project(x, name="Two")  # X owns both here
    n1 = await make_note(p1, title="In one")
    await make_note(p2, title="In two")
    # Explicit project scope narrows to that workspace only.
    notes = await data.query_notes(x.id, project_id=p1.id)
    assert {n["id"] for n in notes} == {n1.id}


# ── Tool-layer write gate (same rule as the REST routes) ────


async def test_create_note_tool_write_gate(
    monkeypatch, make_user, make_project, add_member, tool_fn
):
    owner = await make_user()
    editor = await make_user()
    viewer = await make_user()
    outsider = await make_user()
    proj = await make_project(owner)
    await add_member(proj, editor, "editor")
    await add_member(proj, viewer, "viewer")

    create_note = await tool_fn("create_note")

    async def _as(user):
        monkeypatch.setattr("src.tools.notes.resolve_user", lambda: _coro(user))
        return await create_note(project_id=proj.id, title="T", body="hi")

    # editor: allowed → real note dict.
    res = await _as(editor)
    assert "id" in res and "error" not in res
    # viewer: forbidden.
    assert await _as(viewer) == FORBIDDEN
    # outsider (no membership): not_found (fail-closed, doesn't reveal existence).
    assert await _as(outsider) == NOT_FOUND


def _coro(value):
    async def _c():
        return value

    return _c()


async def test_query_notes_by_last_editor(make_user, make_project, add_member):
    """`updated_by` matches the last editor by name fragment or user id, never
    by email, and only among notes the caller can read."""
    me = await make_user(name="Me")
    bob = await make_user(name="Bob Builder", upn="bob@example.com")
    shared = await make_project(me)
    await add_member(shared, bob, "editor")
    bobs_private = await make_project(bob)

    edited = await data.create_note(shared.id, "Mine, edited by Bob", "v1", me.id)
    await data.update_note(edited.id, None, "v2", bob.id)
    created = await data.create_note(shared.id, "Bob's new note", "x", bob.id)
    await data.create_note(shared.id, "Only mine", "x", me.id)
    await data.create_note(bobs_private.id, "Bob's private", "x", bob.id)

    by_name = await data.query_notes(me.id, updated_by="bob")
    assert {n["id"] for n in by_name} == {edited.id, created.id}
    assert by_name[0]["updated_by"] == {"id": bob.id, "name": "Bob Builder"}
    assert {n["id"] for n in await data.query_notes(me.id, updated_by=bob.id)} == {
        edited.id, created.id}
    assert await data.query_notes(me.id, updated_by="bob@example.com") == []
