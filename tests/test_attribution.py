"""Client attribution (created_via/updated_via + revision.client) and the MCP
create_note "possible_duplicate" nudge threshold."""
from __future__ import annotations

from src import data
from src.tools import notes as notes_tools


async def test_web_path_leaves_via_columns_null(make_user, make_project):
    # Default fixture: mcp_client_name() → None (the web BFF path).
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "T", "body", user.id)
    assert note.created_via is None
    assert note.updated_via is None


async def test_mcp_client_name_stamped_on_note_and_revision(
    monkeypatch, make_user, make_project
):
    monkeypatch.setattr("src.data.mcp_client_name", lambda: "Claude")
    user = await make_user()
    proj = await make_project(user)

    note = await data.create_note(proj.id, "T", "body v1", user.id)
    assert note.created_via == "Claude"
    assert note.updated_via == "Claude"

    updated = await data.update_note(note.id, None, "body v2", user.id)
    assert updated.updated_via == "Claude"

    # A manual "save version" stamps the writing client on the revision row.
    assert await data.create_revision(note.id, user.id, "checkpoint") is True
    revs = await data.list_revisions(note.id)
    assert revs and revs[0]["client"] == "Claude"


# ── possible_duplicate nudge (MCP create_note tool) ─────────


def _async_return(value):
    async def _f(*args, **kwargs):
        return value

    return _f


async def _run_create(monkeypatch, tool_fn, user, proj, neighbor_score):
    """Create a note via the MCP tool with the semantic neighbor lookup steered
    to return a single candidate at `neighbor_score`."""
    monkeypatch.setattr("src.tools.notes.resolve_user", _async_return(user))
    # embed_query must return non-None so _candidates proceeds to neighbors.
    monkeypatch.setattr("src.tools.notes.embed_query", _async_return([0.1] * 1536))
    monkeypatch.setattr(
        "src.data.neighbors_for_text",
        _async_return([
            {"id": "00000000-0000-0000-0000-0000000000aa",
             "title": "Existing", "slug": "existing", "score": neighbor_score}
        ]),
    )
    create_note = await tool_fn("create_note")
    return await create_note(project_id=proj.id, title="New", body="content")


async def test_near_duplicate_yields_possible_duplicate(
    monkeypatch, make_user, make_project, tool_fn
):
    user = await make_user()
    proj = await make_project(user)
    res = await _run_create(monkeypatch, tool_fn, user, proj, neighbor_score=0.95)
    assert "possible_duplicate" in res
    assert res["possible_duplicate"]["score"] == 0.95


async def test_distinct_note_has_no_nudge(
    monkeypatch, make_user, make_project, tool_fn
):
    user = await make_user()
    proj = await make_project(user)
    res = await _run_create(monkeypatch, tool_fn, user, proj, neighbor_score=0.50)
    assert "possible_duplicate" not in res
    # Candidates are still surfaced for the assistant to consider linking.
    assert "link_candidates" in res


async def test_dup_threshold_constant_sanity():
    # The nudge is a conservative >= 0.90 gate (documented anti-fragmentation).
    assert notes_tools._DUP_SCORE == 0.90


# ── author in write responses ───────────────────────────────


async def test_write_responses_name_the_author(monkeypatch, make_user, make_project, tool_fn):
    """create_note / update_note responses carry created_by and updated_by like
    read_note does, so an agent checking authorship right after a write sees it."""
    user = await make_user(name="Ada Lovelace")
    proj = await make_project(user)
    monkeypatch.setattr("src.tools.notes.resolve_user", _async_return(user))
    monkeypatch.setattr("src.tools.notes.embed_query", _async_return(None))

    author = {"id": user.id, "name": "Ada Lovelace"}
    created = await (await tool_fn("create_note"))(project_id=proj.id, title="T", body="v1")
    assert created["created_by"] == author and created["updated_by"] == author

    updated = await (await tool_fn("update_note"))(note_id=created["id"], body="v2")
    assert updated["created_by"] == author and updated["updated_by"] == author
