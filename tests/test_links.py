"""Wikilinks, backlinks, and the rename cascade.

Locks down: [[links]] create resolved edges; a note created AFTER a link
resolves the previously-dangling link; backlinks reverse-resolve; and renaming a
note rewrites inbound [[old]]→[[new]] text (incl. |alias and #anchor) AND keeps
the edge resolved across a subsequent save. Guards under test: indexing stays
lossless (indexes all links) while rewriting leaves fenced/inline code intact,
unsafe and colliding new titles skip the cascade, frontmatter is only rewritten
when the YAML survives, self-links and dangling claims."""
from __future__ import annotations

from src import data
from src.markdown import extract_wikilinks, rewrite_wikilink_target


async def test_wikilink_creates_resolved_edge_and_backlink(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Target", "the target note", user.id)
    source = await data.create_note(proj.id, "Source", "see [[Target]]", user.id)

    backlinks = await data.get_backlinks(target.id)
    assert [b["id"] for b in backlinks] == [source.id]


async def test_link_created_before_target_resolves_on_target_create(
    make_user, make_project
):
    user = await make_user()
    proj = await make_project(user)
    # Source links to a note that doesn't exist yet → dangling edge.
    source = await data.create_note(proj.id, "Source", "see [[Later]]", user.id)
    assert await data.get_backlinks(source.id) == []
    # Creating the target later must resolve the previously-dangling link.
    later = await data.create_note(proj.id, "Later", "now i exist", user.id)
    backlinks = await data.get_backlinks(later.id)
    assert [b["id"] for b in backlinks] == [source.id]


async def test_rename_rewrites_inbound_link_text_incl_alias_and_anchor(
    make_user, make_project
):
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old Title", "target body", user.id)
    body = "a [[Old Title]], b [[Old Title|the alias]], c [[Old Title#intro]]"
    source = await data.create_note(proj.id, "Source", body, user.id)
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [source.id]

    # Rename the target; inbound link TEXT in the source must be rewritten.
    await data.update_note(target.id, "New Title", None, user.id)
    reread = await data.get_note(source.id)
    assert "[[New Title]]" in reread.body
    assert "[[New Title|the alias]]" in reread.body
    assert "[[New Title#intro]]" in reread.body
    assert "Old Title" not in reread.body

    # Edge stays resolved right after the rename...
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [source.id]


async def test_rename_edge_survives_subsequent_save(make_user, make_project):
    """The rot regression: after a rename, the linker's NEXT save must re-resolve
    to the renamed note (not silently unresolve because the old title is gone)."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    source = await data.create_note(proj.id, "Source", "link [[Old]] here", user.id)

    await data.update_note(target.id, "Renamed", None, user.id)
    # Simulate the linker being edited/saved again after the rename.
    src_now = await data.get_note(source.id)
    await data.update_note(source.id, None, src_now.body + "\n\nmore", user.id)

    backlinks = await data.get_backlinks(target.id)
    assert [b["id"] for b in backlinks] == [source.id], (
        "edge rotted: linker's later save unresolved the renamed target"
    )


def test_rewrite_wikilink_target_pure():
    # Pure string op the cascade relies on — case-insensitive, keeps suffixes.
    body = "x [[foo]] y [[Foo|bar]] z [[FOO#h]] and [[other]]"
    out, n = rewrite_wikilink_target(body, "foo", "Baz")
    assert n == 3
    assert out == "x [[Baz]] y [[Baz|bar]] z [[Baz#h]] and [[other]]"


def test_extract_indexes_all_wikilinks_including_code():
    """extract_wikilinks is deliberately blunt: it indexes EVERY [[link]],
    including inside code fences/spans. Over-indexing a code example is a
    harmless extra edge; the alternative (a scanner that mistakes prose for
    code) would make _sync_links silently drop live edges on the next save."""
    body = (
        "real [[Target]]\n"
        "```python\n"
        "code [[Fenced]] here\n"
        "```\n"
        "inline `[[Spanned]]` too\n"
    )
    # Every distinct title is indexed — none dropped by code context.
    assert set(extract_wikilinks(body)) == {"Target", "Fenced", "Spanned"}


def test_rewrite_leaves_code_wikilinks_intact():
    """Link-text REWRITING stays code-aware (unlike indexing): a `[[link]]`
    inside a fence or backtick span is documentation, not a reference to
    rewrite. Only the prose occurrences change."""
    body = (
        "real [[Target]]\n"
        "```python\n"
        "code [[Target]] not rewritten\n"
        "```\n"
        "after [[Target]]\n"
    )
    out, n = rewrite_wikilink_target(body, "Target", "Renamed")
    assert n == 2  # fenced occurrence not rewritten
    assert "code [[Target]] not rewritten" in out  # fenced text byte-for-byte intact
    assert out.count("[[Renamed]]") == 2

    mixed = "real [[T]] and `fake [[T]]`"
    out, n = rewrite_wikilink_target(mixed, "T", "U")
    assert n == 1
    assert out == "real [[U]] and `fake [[T]]`"


def test_rewrite_keeps_frontmatter_when_yaml_would_break():
    """A new title whose quotes would corrupt a frontmatter scalar must leave the
    frontmatter region byte-for-byte intact (broken YAML silently projects as {}
    and wipes hot columns) while the body below is still rewritten."""
    body = "---\nrelated: '[[Old]]'\n---\nsee [[Old]]"
    out, n = rewrite_wikilink_target(body, "Old", "Rock 'n' Roll")
    assert n == 1  # only the body occurrence counts
    assert out.startswith("---\nrelated: '[[Old]]'\n---\n")  # fm reverted verbatim
    assert "see [[Rock 'n' Roll]]" in out


async def test_rename_matches_by_edge_not_shared_title(make_user, make_project):
    """Titles aren't unique (only slugs are). Renaming one 'Guide' must not touch
    a note whose [[Guide]] edge resolved to a DIFFERENT same-titled note."""
    user = await make_user()
    proj = await make_project(user)
    guide1 = await data.create_note(proj.id, "Guide", "first", user.id)
    guide2 = await data.create_note(proj.id, "Guide", "second", user.id)
    assert guide1.slug != guide2.slug  # slugs disambiguate the duplicate titles
    linker = await data.create_note(proj.id, "Linker", "see [[Guide]]", user.id)

    # Force the linker's edge to resolve to guide2 (as it would if guide2 were
    # the intended target) — the point is matching by edge, not text.
    pool = await data.get_pool()
    await pool.execute(
        "UPDATE note_links SET target_note_id = $1::uuid WHERE source_note_id = $2::uuid",
        guide2.id, linker.id,
    )
    assert [b["id"] for b in await data.get_backlinks(guide2.id)] == [linker.id]

    # Rename the FIRST guide. Linker points at guide2 → must be left alone.
    await data.update_note(guide1.id, "Guide One", None, user.id)
    reread = await data.get_note(linker.id)
    assert reread.body == "see [[Guide]]"  # untouched: not corrupted by title match
    assert [b["id"] for b in await data.get_backlinks(guide2.id)] == [linker.id]


async def test_rename_to_unsafe_title_skips_cascade(make_user, make_project):
    """A new title containing a bracket, pipe, hash, or backtick can't round-trip
    inside `[[...]]`, so the cascade is skipped: the rename lands, inbound link
    text is left as-is."""
    user = await make_user()
    proj = await make_project(user)
    # `|`/`#` re-parse as alias/anchor; a backtick can pair with one in the
    # surrounding prose and swallow the link into a code span. Distinct old
    # titles avoid slug reuse across iterations.
    for old_title, bad_title in (
        ("Alpha", "New | Weird"),
        ("Beta", "New #Tag"),
        ("Gamma", "AC`DC"),
    ):
        target = await data.create_note(proj.id, old_title, "t", user.id)
        linker = await data.create_note(
            proj.id, f"Linker {old_title}", f"see [[{old_title}]]", user.id
        )
        assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]

        updated = await data.update_note(target.id, bad_title, None, user.id)
        assert updated.title == bad_title  # primary rename still lands
        reread = await data.get_note(linker.id)
        assert reread.body == f"see [[{old_title}]]"  # no rewrite/corruption/crash


async def test_rename_to_colliding_title_skips_cascade(make_user, make_project):
    """If ANOTHER note already answers to the new title, a rewritten
    `[[new title]]` could re-resolve to it — so the cascade is skipped. The old
    text keeps resolving to the renamed note via its immutable slug."""
    user = await make_user()
    proj = await make_project(user)
    await data.create_note(proj.id, "New", "the incumbent", user.id)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "see [[Old]]", user.id)

    updated = await data.update_note(target.id, "New", None, user.id)
    assert updated.title == "New"  # rename lands; only the rewrite is skipped
    reread = await data.get_note(linker.id)
    assert reread.body == "see [[Old]]"
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]


async def test_rename_collision_guard_checks_slug_too(make_user, make_project):
    """The guard mirrors _sync_links resolution, which also matches by slug: a
    note that OWNS slugify(new_title) — even under a different current title —
    would capture rewritten links."""
    user = await make_user()
    proj = await make_project(user)
    incumbent = await data.create_note(proj.id, "New", "owns slug 'new'", user.id)
    await data.update_note(incumbent.id, "Other", None, user.id)  # slug stays 'new'
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "see [[Old]]", user.id)

    await data.update_note(target.id, "New", None, user.id)
    reread = await data.get_note(linker.id)
    assert reread.body == "see [[Old]]"  # skipped: slugify('New') owned elsewhere
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]


async def test_rename_leaves_fenced_wikilinks_intact(make_user, make_project):
    """A `[[Old]]` inside a fenced block is not a backlink and is not rewritten;
    an `[[Old]]` outside the fence in the same note IS handled."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    body = "outside [[Old]]\n```\ninside [[Old]] fenced\n```\n"
    linker = await data.create_note(proj.id, "Linker", body, user.id)
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]

    await data.update_note(target.id, "New", None, user.id)
    reread = await data.get_note(linker.id)
    assert "outside [[New]]" in reread.body        # outside rewritten
    assert "inside [[Old]] fenced" in reread.body  # fenced text untouched


async def test_rename_reprojects_linker_frontmatter(make_user, make_project):
    """A wikilink living in a linker's frontmatter must be rewritten AND the
    linker's projected metadata refreshed (not left stale on the hot columns)."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old Title", "t", user.id)
    body = "---\nrelated: '[[Old Title]]'\n---\nsees [[Old Title]]"
    linker = await data.create_note(proj.id, "Linker", body, user.id)
    assert linker.metadata["related"] == "[[Old Title]]"

    await data.update_note(target.id, "New Title", None, user.id)
    reread = await data.get_note(linker.id)
    assert reread.metadata["related"] == "[[New Title]]"  # reprojected, not stale
    assert "[[New Title]]" in reread.body
    assert "Old Title" not in reread.body


async def test_rename_preserves_linker_hot_columns_on_yaml_breaking_title(
    make_user, make_project
):
    """DB end of the YAML guard: renaming to a quote-bearing title rewrites the
    linker's body region but leaves its frontmatter — and therefore its
    projected type/tags/status — untouched instead of wiping them."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    body = (
        "---\ntype: spec\nstatus: active\ntags: [a, b]\n"
        "related: '[[Old]]'\n---\nsee [[Old]]"
    )
    linker = await data.create_note(proj.id, "Linker", body, user.id)
    assert linker.type == "spec"

    await data.update_note(target.id, "Rock 'n' Roll", None, user.id)
    reread = await data.get_note(linker.id)
    assert "see [[Rock 'n' Roll]]" in reread.body     # body region rewritten
    assert reread.metadata["related"] == "[[Old]]"    # fm region reverted...
    assert reread.type == "spec"                      # ...hot columns intact
    assert reread.status == "active"
    assert reread.tags == ["a", "b"]


async def test_rename_rewrites_self_links_in_own_body(make_user, make_project):
    """A note referencing itself gets its own body rewritten too — and the row
    returned by update_note reflects the final text (the client's next
    concurrency token must not be stale)."""
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "Old", "see [[Old]]", user.id)
    updated = await data.update_note(note.id, "New", None, user.id)
    assert updated.body == "see [[New]]"
    assert (await data.get_note(note.id)).body == "see [[New]]"

    # Rename + body edit in the same call: the supplied body is rewritten.
    note2 = await data.create_note(proj.id, "Old Two", "x [[Old Two]] y", user.id)
    updated2 = await data.update_note(
        note2.id, "New Two", "edited [[Old Two]] again", user.id
    )
    assert updated2.body == "edited [[New Two]] again"


async def test_rename_self_link_respects_resolved_edge(make_user, make_project):
    """Edge-not-text applies to self-links too: an own-body `[[Old]]` whose edge
    resolves to a duplicate-titled SIBLING must not be rewritten by this note's
    rename."""
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "Old", "me [[Old]]", user.id)
    sibling = await data.create_note(proj.id, "Old", "the other Old", user.id)
    pool = await data.get_pool()
    await pool.execute(
        "UPDATE note_links SET target_note_id = $1::uuid WHERE source_note_id = $2::uuid",
        sibling.id, note.id,
    )

    await data.update_note(note.id, "New", None, user.id)
    assert (await data.get_note(note.id)).body == "me [[Old]]"  # sibling's link


async def test_rename_claims_dangling_links_matching_new_title(
    make_user, make_project
):
    """Renaming a note to a title that dangling links already use adopts them —
    the same claim create/move perform."""
    user = await make_user()
    proj = await make_project(user)
    linker = await data.create_note(proj.id, "Linker", "see [[Future Name]]", user.id)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    assert await data.get_backlinks(target.id) == []

    await data.update_note(target.id, "Future Name", None, user.id)
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]
    # The linker's text already says the new title — nothing was rewritten.
    assert (await data.get_note(linker.id)).body == "see [[Future Name]]"


async def test_rename_case_only_change_rewrites_display_case(
    make_user, make_project
):
    """'Old Note' → 'old note' is a real rename (display case matters) and the
    guard's self-exclusion keeps it from tripping on the note's own title."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old Note", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "see [[Old Note]]", user.id)

    await data.update_note(target.id, "old note", None, user.id)
    assert (await data.get_note(linker.id)).body == "see [[old note]]"
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]


async def test_rename_dedupes_when_linker_already_says_new_title(
    make_user, make_project
):
    """A linker holding both [[Old]] and a dangling [[New]] ends up with two
    [[New]] occurrences — extract dedupes, so re-syncing its links must not
    violate the (source, target_title) primary key."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "[[Old]] and [[New]]", user.id)

    await data.update_note(target.id, "New", None, user.id)
    reread = await data.get_note(linker.id)
    assert reread.body == "[[New]] and [[New]]"
    assert [b["id"] for b in await data.get_backlinks(target.id)] == [linker.id]


async def test_rename_skips_archived_linkers(make_user, make_project):
    """Trashed notes are left byte-for-byte as the user last saw them; their
    stale text still resolves by slug if restored later."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "see [[Old]]", user.id)
    assert await data.archive_note(linker.id, user.id)

    await data.update_note(target.id, "New", None, user.id)
    pool = await data.get_pool()
    body = await pool.fetchval("SELECT body FROM notes WHERE id = $1::uuid", linker.id)
    assert body == "see [[Old]]"


async def test_rename_is_project_scoped(make_user, make_project):
    """Neither the rewrite nor the dangling-link claim may leak into another
    project (links/slugs are per-project namespaces)."""
    user = await make_user()
    proj_a = await make_project(user)
    proj_b = await make_project(user)
    target = await data.create_note(proj_a.id, "Old", "t", user.id)
    b_old = await data.create_note(proj_b.id, "B1", "see [[Old]]", user.id)
    b_new = await data.create_note(proj_b.id, "B2", "see [[New]]", user.id)

    await data.update_note(target.id, "New", None, user.id)
    assert (await data.get_note(b_old.id)).body == "see [[Old]]"  # not rewritten
    pool = await data.get_pool()
    dangling = await pool.fetchval(
        "SELECT target_note_id IS NULL FROM note_links WHERE source_note_id = $1::uuid",
        b_new.id,
    )
    assert dangling  # project B's [[New]] not claimed by project A's rename


async def test_rename_to_whitespace_title_skips_cascade(make_user, make_project):
    """A blank title can't round-trip inside `[[...]]`; the rename itself is the
    status quo (no title validation today) but must not crash or rewrite."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(proj.id, "Linker", "see [[Old]]", user.id)

    updated = await data.update_note(target.id, "   ", None, user.id)
    assert updated.title == "   "
    assert (await data.get_note(linker.id)).body == "see [[Old]]"


async def test_outbound_links_expose_resolved_edges_across_rename(
    make_user, make_project
):
    """The note read's `links` payload maps raw wikilink text → target note id,
    so the UI resolves by id instead of text-matching a cached note list. It
    must stay consistent with the body through a rename (both are rewritten in
    the same transaction) and expose dangling links with a null id."""
    user = await make_user()
    proj = await make_project(user)
    target = await data.create_note(proj.id, "Old", "t", user.id)
    linker = await data.create_note(
        proj.id, "Linker", "see [[Old]] and [[Missing]]", user.id
    )

    links = {ln["target_title"]: ln for ln in await data.get_outbound_links(linker.id)}
    assert links["Old"]["id"] == target.id
    assert links["Old"]["slug"] == "old"
    assert links["Missing"]["id"] is None  # dangling

    await data.update_note(target.id, "New", None, user.id)
    links = {ln["target_title"]: ln for ln in await data.get_outbound_links(linker.id)}
    assert "Old" not in links               # edge text rewritten with the body
    assert links["New"]["id"] == target.id  # still the same note, current title
    assert links["New"]["title"] == "New"


async def test_rename_cascade_snapshots_and_attributes_linker(
    monkeypatch, make_user, make_project
):
    """The cascade rewrite is a canonical edit: it snapshots the linker's prior
    body and stamps the renamer + their client as the linker's updated_by/_via."""
    monkeypatch.setattr("src.data.mcp_client_name", lambda: "Claude")
    editor = await make_user(name="Editor")
    renamer = await make_user(name="Renamer")
    proj = await make_project(editor)
    target = await data.create_note(proj.id, "Old", "t", editor.id)
    linker = await data.create_note(proj.id, "Linker", "prior body [[Old]]", editor.id)

    await data.update_note(target.id, "New", None, renamer.id)

    reread = await data.get_note(linker.id)
    assert "[[New]]" in reread.body
    assert reread.updated_by["id"] == renamer.id  # renamer attributed on the linker
    assert reread.updated_via == "Claude"
    revs = await data.list_revisions(linker.id)
    assert revs, "cascade must leave a prior-body snapshot on the linker"
    prior = await data.get_revision(linker.id, revs[0]["id"])
    assert prior["body"] == "prior body [[Old]]"  # captured before the rewrite
