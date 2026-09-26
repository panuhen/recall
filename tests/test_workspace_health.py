"""Workspace guide conventions, note review, and the health lists.

Everything is flat frontmatter: a note's own `owner`/`review_every`/`reviewed`,
and a guide note's `workspace_types`/`workspace_tags`. Covers the pure rules
(durations, guide parsing, hints, review state, starter guide), the frontmatter
helpers (dates, the one-key setter), the data layer (guide lookup incl. broken
YAML, health lists, mark reviewed, starter guide), and the REST + MCP surfaces
with their permission gates."""
from __future__ import annotations

import json
from datetime import date

import pytest
from fastmcp import FastMCP
from starlette.requests import Request

from src import config, data, guide, state
from src.markdown import (
    frontmatter_problem,
    parse_frontmatter,
    project_metadata,
    set_frontmatter_value,
)

APP = "https://recall.example.com"

GUIDE = """---
type: guide
owner: {owner}
workspace_types: [runbook, decision, note]
workspace_tags: [infra, auth, search]
---
## Purpose
How the Hetzner box is run.
"""


def _async_return(value):
    async def _f(*args, **kwargs):
        return value

    return _f


async def _backdate(note_id: str, *, updated: str | None = None, created: str | None = None):
    pool = await state.get_pool()
    if updated:
        await pool.execute(
            "UPDATE notes SET updated_at = now() - $2::text::interval WHERE id = $1::uuid",
            note_id, updated)
    if created:
        await pool.execute(
            "UPDATE notes SET created_at = now() - $2::text::interval WHERE id = $1::uuid",
            note_id, created)


# ── Durations ───────────────────────────────────────────────


@pytest.mark.parametrize("text, parsed", [
    ("6mo", (6, "mo")), ("30d", (30, "d")), ("2w", (2, "w")), ("1y", (1, "y")),
    (" 12MO ", (12, "mo")),
    # What people naturally type is understood too.
    ("6M", (6, "mo")), ("6m", (6, "mo")), ("6 months", (6, "mo")), ("1 month", (1, "mo")),
    ("every 2 weeks", (2, "w")), ("30 days", (30, "d")), ("1 year", (1, "y")),
    ("2 yrs", (2, "y")), ("every month", (1, "mo")), ("Quarterly", (3, "mo")),
    ("yearly", (1, "y")), ("annually", (1, "y")), ("weekly", (1, "w")),
    ("fortnightly", (2, "w")), ("6  Months", (6, "mo")),
    # Nonsense and non-strings stay unread (and get a hint).
    ("0d", None), ("soon", None), ("6 minutes", None), ("half a year", None),
    ("6", None), ("P6M", None), ("", None), (6, None), (None, None),
])
def test_parse_duration(text, parsed):
    assert guide.parse_duration(text) == parsed


def test_canonical_duration():
    assert guide.canonical_duration("6 months") == "6mo"
    assert guide.canonical_duration("quarterly") == "3mo"
    assert guide.canonical_duration("often") is None


def test_add_duration_clamps_month_end():
    assert guide.add_duration(date(2026, 1, 31), "1mo") == date(2026, 2, 28)
    assert guide.add_duration(date(2026, 3, 15), "12mo") == date(2027, 3, 15)
    assert guide.add_duration(date(2024, 2, 29), "1y") == date(2025, 2, 28)
    assert guide.add_duration(date(2026, 1, 1), "2w") == date(2026, 1, 15)
    assert guide.describe_duration("6mo") == "6 months"
    assert guide.describe_duration("1y") == "year"  # reads "every year"
    assert guide.describe_duration("1 month") == "month"


# ── Parsing the guide ───────────────────────────────────────


def test_parse_conventions_happy_path():
    fm = parse_frontmatter(GUIDE.format(owner="ops@example.com"))[0]
    conv, problems = guide.parse_conventions(fm)
    assert problems == []
    assert conv.to_dict() == {
        "owner": "ops@example.com",
        "types": ["runbook", "decision", "note"],
        "tags": ["infra", "auth", "search"],
    }


def test_guide_frontmatter_is_flat_properties():
    # Every key is a scalar or a flat list: what Obsidian/recall Properties edit.
    fm = parse_frontmatter(GUIDE.format(owner="x"))[0]
    for value in fm.values():
        assert isinstance(value, str) or (
            isinstance(value, list) and all(isinstance(v, str) for v in value))


@pytest.mark.parametrize("fm, needle", [
    ({"workspace_types": {"runbook": {}}}, "`workspace_types`"),
    ({"workspace_tags": {"a": 1}}, "`workspace_tags`"),
    ({"workspace_tags": [{"x": 1}]}, "`workspace_tags`"),
    ({"owner": ["a", "b"]}, "`owner`"),
])
def test_parse_conventions_reports_problems(fm, needle):
    _conv, problems = guide.parse_conventions(fm)
    assert problems and any(needle in p for p in problems)


def test_parse_conventions_accepts_single_strings_and_ignores_other_keys():
    conv, problems = guide.parse_conventions(
        {"workspace_tags": "infra", "aliases": ["Handbook"], "tags": ["meta"]})
    assert problems == [] and conv.tags == ["infra"] and conv.types == []


# ── Hints ───────────────────────────────────────────────────


def _hints(note_type=None, tags=()):
    conv, _ = guide.parse_conventions(parse_frontmatter(GUIDE.format(owner="x"))[0])
    return guide.check_note(conv, note_type, list(tags))


def test_tag_hint_for_close_misspelling_only():
    [h] = _hints(tags=["infrastructure"])
    assert h["code"] == "tag_not_declared"
    assert h["message"] == "`infrastructure` isn't a tag here. Did you mean `infra`?"
    assert _hints(tags=["infar"])[0]["message"].endswith("`infra`?")
    assert _hints(tags=["kubernetes"]) == []  # unrelated: no nagging
    assert _hints(tags=["INFRA"]) == []  # only case differs
    assert _hints(tags=["infra", "auth"]) == []


def test_type_hints():
    [h] = _hints(note_type="runbooks")
    assert h["message"] == "`runbooks` isn't a type here. Did you mean `runbook`?"
    [h] = _hints(note_type="meeting")
    assert "This workspace uses: runbook, decision, note." in h["message"]
    assert _hints(note_type="Runbook") == []


def test_guide_notes_get_no_convention_hints():
    assert _hints(note_type="guide", tags=["infrastructure"]) == []


def test_no_declared_types_or_tags_means_no_hints():
    conv, _ = guide.parse_conventions({})
    assert guide.check_note(conv, "anything", ["whatever"]) == []


def test_review_every_hint():
    assert guide.check_review_every({"review_every": "6mo"}) == []
    assert guide.check_review_every({}) == []
    [h] = guide.check_review_every({"review_every": "half a year"})
    assert h["code"] == "review_every_invalid" and "6mo" in h["message"]


# ── Review state ────────────────────────────────────────────


def test_review_state():
    today = date(2026, 9, 25)
    never = guide.review_state({"review_every": "6mo"}, date(2026, 1, 1), today)
    assert never == {"every": "6mo", "every_text": "6 months", "reviewed": None,
                     "due": "2026-07-01", "overdue": True}
    fresh = guide.review_state({"review_every": "6 months", "reviewed": "2026-09-01"},
                               date(2020, 1, 1), today)
    assert fresh["overdue"] is False and fresh["due"] == "2027-03-01"
    assert fresh["every"] == "6mo" and fresh["every_text"] == "6 months"
    assert guide.review_state({}, date(2020, 1, 1), today) is None
    assert guide.review_state({"review_every": "soon"}, date(2020, 1, 1), today) is None


def test_owner_matches_email_or_name():
    members = [{"upn": "Ops@Example.com", "display_name": "Ops Person"}]
    assert guide.owner_matches("ops@example.com", members)
    assert guide.owner_matches("ops person", members)
    assert not guide.owner_matches("someone@example.net", members)


def test_starter_guide_body_parses_cleanly():
    body = guide.starter_guide_body("me@example.com", ["runbook", "my type", "yes"],
                                    ["infra", "2024"])
    fm = parse_frontmatter(body)[0]
    conv, problems = guide.parse_conventions(fm)
    assert problems == []
    assert fm["type"] == "guide" and conv.owner == "me@example.com"
    assert conv.types == ["runbook", "my type", "yes"]
    assert conv.tags == ["infra", "2024"]
    assert "## Purpose" in body and "review_every: 6mo" in body
    empty = guide.starter_guide_body(None, [], [])
    assert guide.parse_conventions(parse_frontmatter(empty)[0]) == (guide.Conventions(), [])


# ── Frontmatter helpers ─────────────────────────────────────


def test_unquoted_yaml_date_becomes_a_string():
    proj = project_metadata(parse_frontmatter(
        "---\nreviewed: 2026-09-25\nwhen: [2026-01-01]\n---\nx")[0])
    assert proj["metadata"] == {"reviewed": "2026-09-25", "when": ["2026-01-01"]}
    json.dumps(proj["metadata"])  # used to raise TypeError


def test_guide_tags_are_ordinary_tags():
    proj = project_metadata({"type": "guide", "tags": ["meta"], "workspace_tags": ["infra"]})
    assert proj["tags"] == ["meta"] and proj["metadata"]["workspace_tags"] == ["infra"]


def test_set_frontmatter_value():
    body = "---\ntype: runbook\n# keep me\nreviewed: 2020-01-01\ntags:\n  - a\n---\nText"
    out = set_frontmatter_value(body, "reviewed", "2026-09-25")
    assert out == "---\ntype: runbook\n# keep me\nreviewed: 2026-09-25\ntags:\n  - a\n---\nText"
    assert set_frontmatter_value("---\ntype: x\n---\nT", "reviewed", "2026-09-25") == (
        "---\ntype: x\nreviewed: 2026-09-25\n---\nT")
    assert set_frontmatter_value("Just text", "reviewed", "2026-09-25") == (
        "---\nreviewed: 2026-09-25\n---\nJust text")
    assert set_frontmatter_value("---\ntypes: [a\n---\nT", "reviewed", "2026-09-25") is None


def test_frontmatter_problem():
    assert frontmatter_problem("no frontmatter") is None
    assert frontmatter_problem("---\ntype: x\n---\n") is None
    assert "isn't valid YAML" in frontmatter_problem("---\ntypes: [a\n---\n")
    assert "key: value" in frontmatter_problem("---\n- a\n- b\n---\n")


# ── Data layer: guide lookup ────────────────────────────────


async def test_no_guide(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "N", "", user.id)
    assert await data.get_guide(proj.id) is None
    assert await data.note_health(note) == {
        "review": None, "hints": [], "conventions": None, "guide_id": None}
    health = await data.workspace_health(proj.id)
    assert health["counts"]["overdue"] == 0


async def test_review_works_without_a_guide(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    rb = await data.create_note(proj.id, "RB", "---\nreview_every: 6mo\n---\n", user.id)
    bad = await data.create_note(proj.id, "Bad", "---\nreview_every: often\n---\n", user.id)
    await _backdate(rb.id, updated="8 months", created="8 months")
    h = await data.note_health(await data.get_note(rb.id))
    assert h["review"]["overdue"] is True and h["guide_id"] is None
    assert [x["code"] for x in (await data.note_health(bad))["hints"]] == ["review_every_invalid"]
    assert [n["id"] for n in (await data.workspace_health(proj.id))["overdue"]] == [rb.id]


async def test_oldest_guide_wins_and_extra_guide_is_flagged(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    first = await data.create_note(proj.id, "Guide", GUIDE.format(owner=user.upn), user.id)
    second = await data.create_note(proj.id, "Other guide", "---\ntype: guide\n---\n", user.id)
    g = await data.get_guide(proj.id)
    assert g["id"] == first.id and g["guide_count"] == 2
    assert g["summary"] == "How the Hetzner box is run."
    assert g["owner_left"] is False and g["problems"] == []
    assert g["conventions"]["tags"] == ["infra", "auth", "search"]
    [hint] = (await data.note_health(await data.get_note(second.id)))["hints"]
    assert hint["code"] == "extra_guide"


async def test_guide_lists_do_not_count_as_note_tags(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    await data.create_note(proj.id, "Guide", GUIDE.format(owner=user.upn), user.id)
    await data.create_note(proj.id, "N", "---\ntags: [infra]\n---\n", user.id)
    assert await data.list_tags(proj.id) == [{"tag": "infra", "count": 1}]


async def test_broken_guide_is_still_found_and_conventions_are_off(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    g = await data.create_note(
        proj.id, "Guide", "---\ntype: guide\nworkspace_tags: [infra\n---\nPurpose.", user.id)
    note = await data.create_note(proj.id, "N", "---\ntags: [infrastructure]\n---\n", user.id)
    info = await data.get_guide(proj.id)
    assert info["id"] == g.id and info["conventions"] is None
    assert "isn't valid YAML" in info["problems"][0]
    assert (await data.note_health(note))["hints"] == []  # as if no conventions
    [h] = (await data.note_health(await data.get_note(g.id)))["hints"]
    assert h["code"] == "guide_problem"
    # A body line that merely says "type: guide" isn't a guide.
    other = await make_project(user, "Other")
    await data.create_note(other.id, "Doc", "---\ntitle: [x\n---\ntype: guide\n", user.id)
    assert await data.get_guide(other.id) is None


async def test_guide_problem_disables_hints(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    await data.create_note(proj.id, "Guide", (
        "---\ntype: guide\nworkspace_types:\n  runbook: {}\nworkspace_tags: [infra]\n---\n"),
        user.id)
    note = await data.create_note(proj.id, "N", "---\ntags: [infrastructure]\n---\n", user.id)
    info = await data.get_guide(proj.id)
    assert info["conventions"] is None and "`workspace_types`" in info["problems"][0]
    assert (await data.note_health(note))["hints"] == []


async def test_note_health_hints_and_review(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    g = await data.create_note(proj.id, "Guide", GUIDE.format(owner=user.upn), user.id)
    rb = await data.create_note(proj.id, "Restore", (
        "---\ntype: runbooks\ntags: [infrastructure]\nreview_every: 6mo\n---\n"), user.id)
    h = await data.note_health(rb)
    assert h["guide_id"] == g.id
    assert {x["code"] for x in h["hints"]} == {"tag_not_declared", "type_not_declared"}
    assert h["review"]["overdue"] is False and h["review"]["reviewed"] is None
    assert h["conventions"]["types"] == ["runbook", "decision", "note"]


async def test_saving_an_unquoted_date_works(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    n = await data.create_note(proj.id, "N", "---\nreviewed: 2026-09-25\n---\n", user.id)
    assert n.metadata == {"reviewed": "2026-09-25"}


# ── Data layer: health lists ────────────────────────────────


async def test_workspace_health_lists(make_user, make_project, add_member):
    owner = await make_user(upn="owner@example.com")
    gone = await make_user(upn="gone@example.com")
    proj = await make_project(owner)
    await data.create_note(proj.id, "Guide", GUIDE.format(owner=owner.upn), owner.id)

    old = await data.create_note(proj.id, "Old note", "[[Fresh]]", owner.id)
    fresh = await data.create_note(proj.id, "Fresh", "", owner.id)
    reviewed_old = await data.create_note(
        proj.id, "Reviewed", "---\nreviewed: " + date.today().isoformat() + "\n---\n[[Fresh]]",
        owner.id)
    draft = await data.create_note(proj.id, "Draft", "---\nstatus: draft\n---\n", owner.id)
    lonely = await data.create_note(proj.id, "Lonely", "", owner.id)
    dangling = await data.create_note(proj.id, "Dangling", "[[Nowhere]] [[Binned]]", owner.id)
    binned = await data.create_note(proj.id, "Binned", "", owner.id)
    await data.archive_note(binned.id, owner.id)
    due = await data.create_note(proj.id, "Backup runbook", (
        f"---\ntype: runbook\nowner: {gone.upn}\nreview_every: 6mo\n---\n[[Fresh]]"), owner.id)
    ok_rb = await data.create_note(proj.id, "Deploy runbook", (
        f"---\ntype: runbook\nowner: {owner.upn}\nreview_every: 6mo\n"
        f"reviewed: {date.today().isoformat()}\n---\n[[Fresh]]"), owner.id)
    for n in (old, reviewed_old, draft, due, ok_rb):
        await _backdate(n.id, updated="8 months", created="8 months")

    h = await data.workspace_health(proj.id)
    ids = lambda key: [x["id"] for x in h[key]]  # noqa: E731
    assert ids("overdue") == [due.id]
    assert h["overdue"][0]["reviewed"] is None and h["overdue"][0]["every"] == "6mo"
    assert h["overdue"][0]["every_text"] == "6 months"
    assert ids("not_edited") == [old.id]  # reviewed, draft and interval notes excluded
    assert ids("old_drafts") == [draft.id]
    # Dangling only links to a missing and a trashed note, so it counts too.
    assert set(ids("orphans")) == {draft.id, lonely.id, dangling.id}  # guide excluded
    assert sorted((b["target_title"], b["reason"]) for b in h["broken_links"]) == [
        ("Binned", "trashed"), ("Nowhere", "missing")]
    assert h["broken_links"][0]["id"] == dangling.id
    assert [(x["id"], x["owner"]) for x in h["owner_left"]] == [(due.id, gone.upn)]
    assert h["counts"]["orphans"] == 3 and h["stale_after_months"] == 6
    assert fresh.id not in ids("orphans")

    # The owner joins → no longer "left".
    await add_member(proj, gone, "editor")
    assert (await data.workspace_health(proj.id))["owner_left"] == []


async def test_mark_reviewed(make_user, make_project):
    owner = await make_user()
    editor = await make_user(name="Reviewer")
    proj = await make_project(owner)
    body = "---\ntype: runbook\nreview_every: 6 months\n---\nStep 1."
    rb = await data.create_note(proj.id, "Runbook", body, owner.id)
    await _backdate(rb.id, updated="8 months", created="8 months")
    assert [n["id"] for n in (await data.workspace_health(proj.id))["overdue"]] == [rb.id]

    updated = await data.mark_reviewed(rb.id, editor.id, today=date(2026, 9, 25))
    # Only `reviewed:` is added; "6 months" stays exactly as the person wrote it.
    assert updated.body == (
        "---\ntype: runbook\nreview_every: 6 months\nreviewed: 2026-09-25\n---\nStep 1.")
    assert updated.metadata["reviewed"] == "2026-09-25"
    assert (await data.get_note(rb.id)).updated_by["name"] == "Reviewer"

    broken = await data.create_note(proj.id, "Broken", "---\nx: [a\n---\n", owner.id)
    with pytest.raises(data.ReviewError):
        await data.mark_reviewed(broken.id, owner.id)
    assert await data.mark_reviewed("00000000-0000-0000-0000-000000000000", owner.id) is None


async def test_create_starter_guide(make_user, make_project):
    user = await make_user(upn="me@example.com")
    proj = await make_project(user, "Infra")
    for i in range(3):
        await data.create_note(proj.id, f"R{i}", "---\ntype: runbook\ntags: [infra]\n---\n", user.id)
    await data.create_note(proj.id, "D", "---\ntype: decision\ntags: [auth]\n---\n", user.id)
    g = await data.create_starter_guide(proj.id, user)
    assert g.title == "Infra guide" and g.type == "guide" and g.tags == []
    assert g.metadata["workspace_types"] == ["runbook", "decision"]
    info = await data.get_guide(proj.id)
    assert info["problems"] == [] and info["owner"] == "me@example.com"
    assert info["conventions"]["types"] == ["runbook", "decision"]
    assert info["conventions"]["tags"] == ["infra", "auth"]
    with pytest.raises(data.GuideExists) as e:
        await data.create_starter_guide(proj.id, user)
    assert e.value.note_id == g.id


# ── REST routes ─────────────────────────────────────────────


def _request(method: str, path: str, path_params: dict, user: data.User,
             body: dict | None = None) -> Request:
    raw = json.dumps(body).encode() if body is not None else b""

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "path_params": path_params,
            "query_string": b"",
            "headers": [
                (b"x-user-id", user.external_id.encode()),
                (b"x-user-upn", user.upn.encode()),
                (b"content-type", b"application/json"),
            ],
        },
        receive,
    )


async def test_rest_health_and_guide(make_user, make_project, add_member):
    from src import server

    owner = await make_user(oid="owner-oid")
    viewer = await make_user(oid="viewer-oid")
    outsider = await make_user(oid="outsider-oid")
    proj = await make_project(owner)
    await add_member(proj, viewer, "viewer")
    await data.create_note(proj.id, "R", "---\ntype: runbook\ntags: [infra]\n---\n", owner.id)
    path = {"project_id": proj.id}

    resp = await server.api_project_health(_request("GET", "/x", path, viewer))
    got = json.loads(resp.body)
    assert got["guide"] is None and got["can_edit"] is False
    assert got["health"]["counts"]["orphans"] == 1
    resp = await server.api_project_health(_request("GET", "/x", path, outsider))
    assert resp.status_code == 404

    resp = await server.api_create_guide(_request("POST", "/x", path, viewer))
    assert resp.status_code == 403
    resp = await server.api_create_guide(_request("POST", "/x", path, owner))
    assert resp.status_code == 201
    gid = json.loads(resp.body)["id"]
    resp = await server.api_create_guide(_request("POST", "/x", path, owner))
    assert resp.status_code == 409 and json.loads(resp.body)["note_id"] == gid

    got = json.loads((await server.api_project_health(_request("GET", "/x", path, owner))).body)
    assert got["guide"]["id"] == gid and "body" not in got["guide"]
    assert got["guide"]["conventions"] == {
        "owner": owner.upn, "types": ["runbook"], "tags": ["infra"]}
    assert got["can_edit"] is True


async def test_rest_note_carries_hints_and_mark_reviewed(make_user, make_project, add_member):
    from src import server

    owner = await make_user(oid="owner-oid")
    viewer = await make_user(oid="viewer-oid")
    proj = await make_project(owner)
    await add_member(proj, viewer, "viewer")
    await data.create_note(proj.id, "Guide", GUIDE.format(owner=owner.upn), owner.id)
    rb = await data.create_note(proj.id, "RB", (
        "---\ntype: runbook\ntags: [infrastructure]\nreview_every: 6mo\n---\n"), owner.id)
    path = {"note_id": rb.id}

    got = json.loads((await server.api_get_note(_request("GET", "/x", path, viewer))).body)
    assert [h["code"] for h in got["hints"]] == ["tag_not_declared"]
    assert got["review"]["every"] == "6mo" and got["conventions"]["tags"]

    resp = await server.api_update_note(_request("PATCH", "/x", path, owner, {
        "body": "---\ntype: runbook\ntags: [infra]\nreview_every: 6mo\n---\n"}))
    assert json.loads(resp.body)["hints"] == []

    resp = await server.api_mark_reviewed(_request("POST", "/x", path, viewer))
    assert resp.status_code == 403
    resp = await server.api_mark_reviewed(_request("POST", "/x", path, owner))
    got = json.loads(resp.body)
    assert resp.status_code == 200
    assert got["metadata"]["reviewed"] == date.today().isoformat()
    assert got["review"]["reviewed"] == date.today().isoformat()
    assert got["review"]["overdue"] is False


# ── MCP tools ───────────────────────────────────────────────


@pytest.fixture
def tools(monkeypatch):
    """Health, organize and note tools with resolve_user pointed at a user."""
    from src.tools import health as health_tools
    from src.tools import notes as notes_tools
    from src.tools import organize as organize_tools

    monkeypatch.setattr(config, "APP_URL", APP)
    mcp = FastMCP("test")
    health_tools.register(mcp)
    organize_tools.register(mcp)
    notes_tools.register(mcp)

    def as_user(user):
        for mod in (health_tools, organize_tools, notes_tools):
            monkeypatch.setattr(mod, "resolve_user", _async_return(user))

    async def get(name: str):
        return (await mcp.get_tool(name)).fn

    return as_user, get


async def test_mcp_health_tools(tools, make_user, make_project, add_member):
    as_user, get = tools
    owner = await make_user()
    viewer = await make_user()
    proj = await make_project(owner)
    await add_member(proj, viewer, "viewer")
    rb = await data.create_note(
        proj.id, "RB", "---\ntype: runbook\nreview_every: 6mo\n---\n", owner.id)
    dec = await data.create_note(proj.id, "Dec", "---\ntype: decision\n---\n", owner.id)
    await _backdate(rb.id, updated="8 months", created="8 months")
    await _backdate(dec.id, updated="8 months", created="8 months")

    as_user(viewer)
    health = await (await get("workspace_health"))(proj.id)
    assert [n["id"] for n in health["overdue"]] == [rb.id]
    assert health["overdue"][0]["url"] == f"{APP}/notes/{rb.id}"
    assert [n["id"] for n in health["not_edited"]] == [dec.id]
    stale = await (await get("stale_notes"))(proj.id, type="runbook")
    assert stale["total"] == 1 and stale["notes"][0]["url"].endswith(rb.id)
    assert (await (await get("stale_notes"))(proj.id, type="decision"))["total"] == 0
    assert await (await get("mark_reviewed"))(rb.id) == {"error": "forbidden"}

    as_user(owner)
    res = await (await get("mark_reviewed"))(rb.id)
    assert res["reviewed"] == date.today().isoformat() and res["review"]["overdue"] is False
    assert (await (await get("stale_notes"))(proj.id))["total"] == 0

    outsider = await make_user()
    as_user(outsider)
    assert await (await get("workspace_health"))(proj.id) == {"error": "not_found"}


async def test_mcp_guide_in_tree_and_hints_on_write(tools, make_user, make_project):
    as_user, get = tools
    owner = await make_user()
    proj = await make_project(owner)
    as_user(owner)
    tree = await (await get("list_tree"))(proj.id)
    assert tree["guide"] is None

    g = await data.create_note(proj.id, "Guide", GUIDE.format(owner=owner.upn), owner.id)
    tree = await (await get("list_tree"))(proj.id)
    assert tree["guide"]["id"] == g.id and "## Purpose" in tree["guide"]["body"]
    assert tree["guide"]["url"] == f"{APP}/notes/{g.id}"
    assert tree["guide"]["conventions"]["tags"] == ["infra", "auth", "search"]

    created = await (await get("create_note"))(
        proj.id, "Ops", "---\ntype: note\ntags: [infrastructure]\n---\nx")
    assert [h["code"] for h in created["convention_hints"]] == ["tag_not_declared"]
    assert created["workspace_guide"]["id"] == g.id
    assert created["workspace_guide"]["url"] == f"{APP}/notes/{g.id}"
    assert created["workspace_guide"]["conventions"]["types"] == ["runbook", "decision", "note"]
    updated = await (await get("update_note"))(
        created["id"], body="---\ntype: note\ntags: [infra]\n---\nx")
    # A clean write still names the guide, so it can't be missed.
    assert "convention_hints" not in updated
    assert updated["workspace_guide"]["id"] == g.id
    read = await (await get("read_note"))(created["id"])
    assert read["convention_hints"] == [] and read["review"] is None


async def test_creating_the_missing_note_clears_the_link(make_user, make_project):
    # The web app's "click a missing link" creates a note with the link's title;
    # the waiting link must resolve at once and leave the Health list.
    user = await make_user()
    proj = await make_project(user)
    src = await data.create_note(proj.id, "Ops", "See [[Session storage#Why]].", user.id)
    assert [b["target_title"] for b in (await data.workspace_health(proj.id))["broken_links"]] == [
        "Session storage"]
    created = await data.create_note(proj.id, "Session storage", "", user.id)
    assert (await data.workspace_health(proj.id))["broken_links"] == []
    assert [b["id"] for b in await data.get_backlinks(created.id)] == [src.id]


async def test_mcp_write_without_guide_has_no_guide_keys(tools, make_user, make_project):
    as_user, get = tools
    owner = await make_user()
    proj = await make_project(owner)
    as_user(owner)
    created = await (await get("create_note"))(proj.id, "Plain", "x")
    assert "workspace_guide" not in created and "convention_hints" not in created
