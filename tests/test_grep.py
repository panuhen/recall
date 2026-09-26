"""Exact-text grep: the excerpt format (pure) and grep_notes scoping."""
from __future__ import annotations

from src import data
from src.markdown import grep_excerpt


def test_excerpt_uses_grep_context_format():
    body = "a\nb ERR_42 here\nc\nd\ne\nf\nerr_42 again\ng"
    excerpt, count = grep_excerpt(body, "err_42")
    assert count == 2
    assert excerpt == "1-a\n2:b ERR_42 here\n3-c\n--\n6-f\n7:err_42 again\n8-g"


def test_excerpt_merges_overlapping_context_and_caps_matches():
    body = "\n".join(["x hit"] * 8)
    excerpt, count = grep_excerpt(body, "hit", max_matches=3)
    assert count == 8
    assert excerpt.splitlines() == ["1:x hit", "2:x hit", "3:x hit", "4-x hit"]


def test_excerpt_cuts_long_lines_around_the_match():
    line = "a" * 500 + " NEEDLE " + "b" * 500
    excerpt, _ = grep_excerpt(line, "needle", width=60)
    text = excerpt.split(":", 1)[1]
    assert "NEEDLE" in text and text.startswith("…") and text.endswith("…")
    assert len(text) <= 62


def test_excerpt_counts_frontmatter_lines():
    body = "---\nsource: https://example.com/page\n---\nbody"
    excerpt, count = grep_excerpt(body, "example.com")
    assert count == 1 and "2:source: https://example.com/page" in excerpt


async def test_grep_is_literal_and_scoped(make_user, make_project):
    me = await make_user()
    other = await make_user()
    mine = await make_project(me)
    theirs = await make_project(other)
    hit = await data.create_note(mine.id, "Deploy", "fails with ERR_42 on start", me.id)
    await data.create_note(mine.id, "Other", "fails with ERR 42 on start", me.id)
    await data.create_note(theirs.id, "Private", "ERR_42 here too", other.id)

    results = await data.grep_notes(me.id, "err_42", None, 20)
    assert [r["id"] for r in results] == [hit.id]
    assert results[0]["excerpt"] == "1:fails with ERR_42 on start"
    assert results[0]["match_count"] == 1 and results[0]["title_match"] is False


async def test_grep_finds_title_only_matches(make_user, make_project):
    me = await make_user()
    proj = await make_project(me)
    await data.create_note(proj.id, "Coolify notes", "nothing here", me.id)
    [r] = await data.grep_notes(me.id, "coolify", proj.id, 20)
    assert r["title_match"] is True and r["match_count"] == 0 and r["excerpt"] == ""


async def test_grep_tool_rejects_one_character(monkeypatch, make_user, tool_fn):
    user = await make_user()

    async def _me():
        return user

    monkeypatch.setattr("src.tools.search.resolve_user", _me)
    grep = await tool_fn("grep")
    assert (await grep(text=" x "))["error"] == "text_too_short"
    assert (await grep(text="zz")) == {"results": []}
