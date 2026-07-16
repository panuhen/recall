"""YAML frontmatter → column projection: type/tags/status become hot columns,
everything else lands in the metadata JSONB (via create_note/update_note)."""
from __future__ import annotations

from src import data


async def test_create_projects_frontmatter_into_columns(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    body = (
        "---\n"
        "type: meeting\n"
        "tags: [alpha, beta]\n"
        "status: open\n"
        "priority: high\n"
        "attendees: 3\n"
        "---\n"
        "# Notes\n\nbody text\n"
    )
    note = await data.create_note(proj.id, "Standup", body, user.id)
    assert note.type == "meeting"
    assert note.tags == ["alpha", "beta"]
    assert note.status == "open"
    # Unknown keys are preserved in the JSONB projection, not the hot columns.
    assert note.metadata == {"priority": "high", "attendees": 3}
    # Full markdown (incl. frontmatter) stays the source of truth in body.
    assert note.body == body


async def test_comma_string_tags_normalized_to_list(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(
        proj.id, "T", "---\ntags: one, two ,three\n---\nx", user.id
    )
    assert note.tags == ["one", "two", "three"]


async def test_no_frontmatter_yields_empty_projection(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "Plain", "just a body, no yaml", user.id)
    assert note.type is None
    assert note.status is None
    assert note.tags == []
    assert note.metadata == {}


async def test_update_reprojects_frontmatter(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(
        proj.id, "T", "---\ntype: note\ntags: [x]\nstatus: draft\n---\nbody", user.id
    )
    updated = await data.update_note(
        note.id, None,
        "---\ntype: task\ntags: [y, z]\nstatus: done\nowner: ada\n---\nbody2",
        user.id,
    )
    assert updated.type == "task"
    assert updated.tags == ["y", "z"]
    assert updated.status == "done"
    assert updated.metadata == {"owner": "ada"}

    # Persisted (not just returned): a fresh read reflects the reprojection.
    reread = await data.get_note(note.id)
    assert reread.type == "task"
    assert reread.tags == ["y", "z"]
    assert reread.status == "done"
