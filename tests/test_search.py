"""Hybrid RRF search: keyword-only fallback when no query vector, and the
semantic side genuinely contributing when a query vector + note embedding are
present. Assertions are about membership/among-results, not exact scores."""
from __future__ import annotations

from src import data, state
from src.embeddings_provider import to_pgvector


def vector(dim_index: int, size: int = 1536) -> list[float]:
    """A unit basis vector (1.0 at dim_index, else 0.0) for injecting note
    embeddings / query vectors. Identical index ⇒ cosine distance 0."""
    v = [0.0] * size
    v[dim_index] = 1.0
    return v


async def _set_embedding(note_id: str, vec: list[float]) -> None:
    pool = await state.get_pool()
    await pool.execute(
        "UPDATE notes SET embedding = $2::vector WHERE id = $1::uuid",
        note_id, to_pgvector(vec),
    )


async def test_keyword_only_fallback_when_no_query_vector(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    hit = await data.create_note(proj.id, "Hit", "the elusive pangolin roams", user.id)
    await data.create_note(proj.id, "Miss", "totally unrelated content", user.id)

    results = await data.search_notes(user.id, "pangolin", None, None, 20)
    ids = {r["id"] for r in results}
    assert hit.id in ids
    # A note that matches neither keyword nor (absent) semantics is excluded.
    assert len(ids) == 1


async def test_semantic_side_contributes_when_vector_present(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    # Matches the query term "pangolin" lexically.
    kw = await data.create_note(proj.id, "Keyword", "a pangolin appears", user.id)
    # Does NOT contain the term, but we give it an embedding equal to the query
    # vector — so it can only surface via the semantic arm of the fusion.
    sem = await data.create_note(proj.id, "Semantic", "an armored anteater", user.id)
    await _set_embedding(sem.id, vector(0))
    qvec = vector(0)

    # Without a query vector, the semantic-only note is invisible.
    kw_only = {r["id"] for r in await data.search_notes(user.id, "pangolin", None, None, 20)}
    assert sem.id not in kw_only
    assert kw.id in kw_only

    # With the query vector, the semantic arm pulls the embedded note in.
    hybrid = {r["id"] for r in await data.search_notes(user.id, "pangolin", qvec, None, 20)}
    assert sem.id in hybrid, "semantic arm did not contribute a vector-only match"
    assert kw.id in hybrid


async def test_search_excludes_other_project_even_with_vector(
    make_user, make_project
):
    x = await make_user()
    y = await make_user()
    px = await make_project(x)
    py = await make_project(y)
    mine = await data.create_note(px.id, "Mine", "a pangolin here", x.id)
    await _set_embedding(mine.id, vector(0))
    theirs = await data.create_note(py.id, "Theirs", "a pangolin here too", x.id)
    await _set_embedding(theirs.id, vector(0))

    # Even with a matching query vector, Y's note stays out of X's results,
    # while X's own equally-matching note is returned.
    ids = {r["id"] for r in await data.search_notes(x.id, "pangolin", vector(0), None, 20)}
    assert mine.id in ids
    assert theirs.id not in ids


async def test_keyword_snippet_centres_on_the_match(make_user, make_project):
    """A keyword hit's snippet shows the passage with the matched words, not
    the note's opening, so the assistant can judge it without reading it."""
    user = await make_user()
    proj = await make_project(user)
    filler = " ".join(f"word{i}" for i in range(120))
    body = f"---\ntype: note\n---\n{filler}\n\nThe pangolin deploy failed at night.\n\n{filler}"
    await data.create_note(proj.id, "Long", body, user.id)

    [hit] = await data.search_notes(user.id, "pangolin", None, None, 20)
    assert "pangolin deploy failed" in hit["snippet"]
    assert hit["snippet"].startswith("…") and hit["snippet"].endswith("…")
    assert "type: note" not in hit["snippet"]
    assert len(hit["snippet"]) <= 302


async def test_semantic_only_snippet_is_the_opening(make_user, make_project):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "Sem", "---\ntags: [x]\n---\nOpening line here.", user.id)
    await _set_embedding(note.id, vector(3))

    [hit] = await data.search_notes(user.id, "zzzunmatched", vector(3), None, 20)
    assert hit["snippet"] == "Opening line here."
