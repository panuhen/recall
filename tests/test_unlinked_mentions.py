"""Unlinked mentions: plain-text occurrences of a note's title/aliases in other
notes of the same workspace, and the one-click linker.

Covers the pure matching rules (word boundaries, case, Unicode, ignored
regions, aliases, stoplist, min length), the SQL scope (workspace, archived,
already-linking, self), the link-first-occurrence edit (content, revision,
backlink), permissions (viewer lists but can't link) for REST and MCP, and the
MCP tools' shapes."""
from __future__ import annotations

import json

import pytest
from starlette.requests import Request

from src import config, data
from src.markdown import (
    MentionMatcher,
    mention_link_text,
    mention_masked_spans,
    mention_snippet,
    mention_terms,
)
from src.tools._base import FORBIDDEN

APP = "https://recall.example.com"


def _first(title: str, body: str, metadata: dict | None = None):
    return MentionMatcher(mention_terms(title, metadata)).first(body)


def _async_return(value):
    async def _f(*args, **kwargs):
        return value

    return _f


# ── Pure matching rules ─────────────────────────────────────


@pytest.mark.parametrize(
    "body, hit",
    [
        ("The worker restarts nightly.", "worker"),
        ("WORKER down", "WORKER"),
        ("see Worker.", "Worker"),
        ("(worker)", "worker"),
        ("the worker's queue", "worker"),
        ("a coworker helped", None),
        ("two workers", None),
        ("reworkered", None),
        ("worker_pool", None),  # underscore is a word character
    ],
)
def test_whole_word_case_insensitive(body, hit):
    m = _first("Worker", body)
    assert (m.text if m else None) == hit


def test_unicode_word_boundaries_finnish():
    # Case-insensitive across non-ASCII letters.
    m = _first("Järjestelmä", "Koko JÄRJESTELMÄ toimii.")
    assert m and m.text == "JÄRJESTELMÄ"
    # Inflected / compound forms are longer words → no match (no stemming).
    assert _first("Järjestelmä", "järjestelmän osa ja tietojärjestelmä") is None
    # A non-ASCII letter adjacent to the term counts as a word character.
    assert _first("Kivi", "äkivi ja kiviä") is None
    assert _first("Kivi", "iso kivi.").text == "kivi"


def test_multi_word_title_allows_flexible_spaces_not_newlines():
    assert _first("Graph demo", "the graph   demo works").text == "graph   demo"
    assert _first("Graph demo", "the graph\ndemo works") is None


def test_longest_term_wins_at_a_position():
    m = _first("Worker", "the worker pool is busy", {"aliases": ["worker pool"]})
    assert m.text == "worker pool" and m.term == "worker pool"


@pytest.mark.parametrize(
    "body",
    [
        "```\nthe worker\n```\n",
        "~~~python\nworker = 1\n~~~\n",
        "use `worker` here",
        "use ``the worker`` here",
        "see [[Worker]] and [[Worker|the worker]]",
        "see [the worker](https://example.com)",
        "see [docs](https://example.com/worker)",
        "![worker](img.png)",
        "see [the worker][ref]\n\n[ref]: https://example.com/worker",
        "open https://example.com/worker/status now",
        "<https://example.com/worker>",
        "---\ntitle: about the worker\nrelated: worker\n---\nNothing here.",
    ],
)
def test_ignored_regions(body):
    assert _first("Worker", body) is None


def test_plain_mention_after_ignored_regions_is_found():
    body = (
        "---\nsummary: worker\n---\n"
        "`worker` [[Worker]] [worker](x) https://x/worker\n"
        "```\nworker\n```\n"
        "Finally the worker."
    )
    m = _first("Worker", body)
    assert m and body[m.start:m.end] == "worker" and body[m.start - 4:m.start] == "the "


def test_unclosed_fence_masks_to_end():
    assert _first("Worker", "text\n```\nworker forever") is None


def test_masked_spans_cover_frontmatter_and_fences():
    body = "---\na: 1\n---\nplain\n```\ncode\n```\nmore"
    spans = mention_masked_spans(body)
    assert spans[0] == (0, body.index("plain"))
    fence = body.index("```")
    assert (fence, body.index("more")) in spans


def test_aliases_list_and_string():
    assert mention_terms("Worker", {"aliases": ["Job runner", "bg worker"]}) == [
        "Worker", "Job runner", "bg worker",
    ]
    assert mention_terms("Worker", {"aliases": "Job runner"}) == ["Worker", "Job runner"]
    # Non-string entries and non-list/str values are ignored.
    assert mention_terms("Worker", {"aliases": [3, None, "Runner"]}) == ["Worker", "Runner"]
    assert mention_terms("Worker", {"aliases": {"a": 1}}) == ["Worker"]
    m = _first("Worker", "the job RUNNER stalled", {"aliases": ["Job runner"]})
    assert m.text == "job RUNNER" and m.term == "Job runner"


def test_stoplist_min_length_and_dedupe():
    # Generic single-word titles are skipped; phrases containing them are not.
    assert mention_terms("Todo", {}) == []
    assert mention_terms("notes", {"aliases": ["Meeting notes"]}) == ["Meeting notes"]
    assert mention_terms("Draft plan", {}) == ["Draft plan"]
    # Shorter than 3 characters (after whitespace collapse) → skipped.
    assert mention_terms("AI", {"aliases": ["ML", "GPU"]}) == ["GPU"]
    assert mention_terms("Worker", {"aliases": ["  ", "WORKER", "wo"]}) == ["Worker"]
    # No word character at all (would match horizontal rules) → skipped.
    assert mention_terms("---", {}) == []
    assert _first("Todo", "todo: buy milk") is None


def test_unsafe_title_yields_no_terms():
    # A title that can't sit inside [[...]] can't be linked, so no mentions.
    assert mention_terms("C# notes", {}) == []
    assert mention_terms("a|b title", {"aliases": ["safe alias"]}) == []
    # Unsafe aliases are dropped individually.
    assert mention_terms("Worker", {"aliases": ["bad]alias"]}) == ["Worker"]


def test_link_text_forms():
    body = "The Worker and the worker"
    m = _first("Worker", body)
    assert mention_link_text("Worker", m, body) == "[[Worker]]"
    body2 = "the worker"
    m2 = _first("Worker", body2)
    assert mention_link_text("Worker", m2, body2) == "[[Worker|worker]]"
    # Inside a GFM table row a `|` would split the cell.
    body3 = "| a | the worker |\n"
    m3 = _first("Worker", body3)
    assert mention_link_text("Worker", m3, body3) == "[[Worker]]"


def test_snippet_is_bounded_and_stays_in_paragraph():
    long = "word " * 60
    body = f"---\nx: 1\n---\nFirst para.\n\n{long}the worker restarts {long}\n\nNext para."
    m = _first("Worker", body)
    snip = mention_snippet(body, m.start, m.end)
    assert "worker" in snip and snip.startswith("…") and snip.endswith("…")
    assert len(snip) <= 125
    assert "First para" not in snip and "Next para" not in snip and "x: 1" not in snip
    short = "Intro.\n\nThe worker restarts.\n\nOutro."
    m = _first("Worker", short)
    assert mention_snippet(short, m.start, m.end) == "The worker restarts."


# ── Data layer: scope + exclusions ──────────────────────────


async def test_lists_mentions_with_scope_and_exclusions(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    other = await make_project(user, name="Other")
    x = await data.create_note(proj.id, "Worker", "---\naliases: [Job runner]\n---\nI am the worker.", user.id)
    plain = await data.create_note(proj.id, "Ops", "When the worker restarts, check logs.", user.id)
    alias = await data.create_note(proj.id, "Alias user", "The job runner stalled.", user.id)
    await data.create_note(proj.id, "Linked", "The [[Worker]] and the worker.", user.id)
    await data.create_note(proj.id, "Coworkers", "My coworker and the workers.", user.id)
    await data.create_note(proj.id, "Code only", "```\nworker\n```\n`worker`", user.id)
    await data.create_note(other.id, "Elsewhere", "the worker again", user.id)
    trashed = await data.create_note(proj.id, "Trashed", "the worker is gone", user.id)
    await data.archive_note(trashed.id, user.id)

    rows = await data.get_unlinked_mentions(x.id)
    assert [r["id"] for r in rows] == [alias.id, plain.id]  # ordered by title
    by_id = {r["id"]: r for r in rows}
    assert by_id[plain.id]["term"] == "Worker" and by_id[plain.id]["match"] == "worker"
    assert by_id[plain.id]["snippet"] == "When the worker restarts, check logs."
    assert by_id[alias.id]["term"] == "Job runner" and by_id[alias.id]["match"] == "job runner"
    assert set(rows[0]) == {"id", "title", "slug", "term", "match", "snippet", "updated_at"}


async def test_limit_caps_results(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    x = await data.create_note(proj.id, "Worker", "", user.id)
    for i in range(5):
        await data.create_note(proj.id, f"N{i}", "the worker", user.id)
    assert len(await data.get_unlinked_mentions(x.id, limit=3)) == 3
    assert len(await data.get_unlinked_mentions(x.id)) == 5


async def test_stoplisted_title_has_no_mentions(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    x = await data.create_note(proj.id, "Todo", "", user.id)
    await data.create_note(proj.id, "Other", "my todo list", user.id)
    assert await data.get_unlinked_mentions(x.id) == []


async def test_prefilter_handles_unicode_case(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    x = await data.create_note(proj.id, "Järjestelmä", "", user.id)
    src = await data.create_note(proj.id, "Kuvaus", "KOKO JÄRJESTELMÄ käynnistyy.", user.id)
    rows = await data.get_unlinked_mentions(x.id)
    assert [r["id"] for r in rows] == [src.id]


# ── Data layer: linking ─────────────────────────────────────


async def test_link_rewrites_first_plain_occurrence(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    x = await data.create_note(proj.id, "Worker", "", user.id)
    body = "Use `worker` here.\n\nThe worker restarts. Another worker too."
    src = await data.create_note(proj.id, "Ops", body, user.id)

    updated = await data.link_unlinked_mention(x.id, src.id, user.id)
    assert updated.body == (
        "Use `worker` here.\n\nThe [[Worker|worker]] restarts. Another worker too."
    )
    # A revision of the prior body was taken, the edge resolves, and the source
    # now shows in backlinks instead of unlinked mentions.
    revs = await data.list_revisions(src.id)
    assert len(revs) == 1
    assert (await data.get_revision(src.id, revs[0]["id"]))["body"] == body
    assert [b["id"] for b in await data.get_backlinks(x.id)] == [src.id]
    assert await data.get_unlinked_mentions(x.id) == []
    assert updated.updated_by is None or updated.updated_by["id"] == user.id

    # Linking again is refused (the source already links here).
    with pytest.raises(data.MentionLinkError) as e:
        await data.link_unlinked_mention(x.id, src.id, user.id)
    assert e.value.code == "already_linked"


async def test_link_exact_case_uses_bare_title(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    x = await data.create_note(proj.id, "Graph demo", "", user.id)
    src = await data.create_note(proj.id, "Ops", "The Graph demo is live.", user.id)
    updated = await data.link_unlinked_mention(x.id, src.id, user.id)
    assert updated.body == "The [[Graph demo]] is live."


async def test_link_errors(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    other = await make_project(user, name="Other")
    x = await data.create_note(proj.id, "Worker", "", user.id)
    none = await data.create_note(proj.id, "Nothing", "no mention here", user.id)
    far = await data.create_note(other.id, "Far", "the worker", user.id)

    for source_id, code in ((none.id, "no_mention"), (far.id, "not_found"), (x.id, "not_found")):
        with pytest.raises(data.MentionLinkError) as e:
            await data.link_unlinked_mention(x.id, source_id, user.id)
        assert e.value.code == code


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


async def test_rest_viewer_can_list_but_not_link(make_user, make_project, add_member):
    from src import server

    owner = await make_user(oid="owner-oid")
    viewer = await make_user(oid="viewer-oid")
    proj = await make_project(owner)
    await add_member(proj, viewer, "viewer")
    x = await data.create_note(proj.id, "Worker", "", owner.id)
    src = await data.create_note(proj.id, "Ops", "the worker restarts", owner.id)
    path = {"note_id": x.id}

    resp = await server.api_unlinked_mentions(
        _request("GET", f"/api/notes/{x.id}/unlinked-mentions", path, viewer))
    mentions = json.loads(resp.body)["mentions"]
    assert [m["id"] for m in mentions] == [src.id] and mentions[0]["can_edit"] is False

    resp = await server.api_link_unlinked_mention(_request(
        "POST", f"/api/notes/{x.id}/unlinked-mentions/link", path, viewer,
        {"source_note_id": src.id}))
    assert resp.status_code == 403
    assert (await data.get_note(src.id)).body == "the worker restarts"

    resp = await server.api_unlinked_mentions(
        _request("GET", f"/api/notes/{x.id}/unlinked-mentions", path, owner))
    assert json.loads(resp.body)["mentions"][0]["can_edit"] is True
    resp = await server.api_link_unlinked_mention(_request(
        "POST", f"/api/notes/{x.id}/unlinked-mentions/link", path, owner,
        {"source_note_id": src.id}))
    assert resp.status_code == 200
    assert json.loads(resp.body)["body"] == "the [[Worker|worker]] restarts"

    # Nothing left to link → 409; bad input → 400; unknown source → 404.
    resp = await server.api_link_unlinked_mention(_request(
        "POST", "/x", path, owner, {"source_note_id": src.id}))
    assert resp.status_code == 409 and json.loads(resp.body)["error"] == "already_linked"
    resp = await server.api_link_unlinked_mention(_request("POST", "/x", path, owner, {}))
    assert resp.status_code == 400
    resp = await server.api_link_unlinked_mention(_request(
        "POST", "/x", path, owner, {"source_note_id": "not-a-uuid"}))
    assert resp.status_code == 404


async def test_rest_outsider_gets_404(make_user, make_project):
    from src import server

    owner = await make_user(oid="owner-oid")
    outsider = await make_user(oid="outsider-oid")
    proj = await make_project(owner)
    x = await data.create_note(proj.id, "Worker", "", owner.id)
    resp = await server.api_unlinked_mentions(
        _request("GET", "/x", {"note_id": x.id}, outsider))
    assert resp.status_code == 404


# ── MCP tools ───────────────────────────────────────────────


async def test_mcp_unlinked_mentions_and_link_mention(
    monkeypatch, tool_fn, make_user, make_project, add_member
):
    monkeypatch.setattr(config, "APP_URL", APP)
    owner = await make_user()
    viewer = await make_user()
    proj = await make_project(owner)
    await add_member(proj, viewer, "viewer")
    x = await data.create_note(proj.id, "Worker", "", owner.id)
    src = await data.create_note(proj.id, "Ops", "When the Worker restarts", owner.id)

    for mod in ("notes", "search"):
        monkeypatch.setattr(f"src.tools.{mod}.resolve_user", _async_return(viewer))
    listed = await (await tool_fn("unlinked_mentions"))(note_id=x.id)
    assert listed["can_edit"] is False
    [row] = listed["mentions"]
    assert row["id"] == src.id and row["url"] == f"{APP}/notes/{src.id}"
    assert row["term"] == "Worker" and row["match"] == "Worker"
    link = await tool_fn("link_mention")
    assert await link(note_id=x.id, source_note_id=src.id) == FORBIDDEN

    for mod in ("notes", "search"):
        monkeypatch.setattr(f"src.tools.{mod}.resolve_user", _async_return(owner))
    monkeypatch.setattr("src.data.mcp_client_name", lambda: "Claude")
    out = await link(note_id=x.id, source_note_id=src.id)
    assert out["updated_via"] == "Claude"  # attributed like any MCP edit
    assert out["id"] == src.id and out["body"] == "When the [[Worker]] restarts"
    assert out["url"] == f"{APP}/notes/{src.id}"
    assert out["linked_to"] == {"id": x.id, "title": "Worker", "url": f"{APP}/notes/{x.id}"}
    assert await link(note_id=x.id, source_note_id=src.id) == {"error": "already_linked"}
    assert (await (await tool_fn("unlinked_mentions"))(note_id=x.id))["mentions"] == []
