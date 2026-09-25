"""Note tools: read, create, update, link (append or convert a mention), save a
version.

Writes require editor+ (the same gate as the REST routes). `create_note` and
`update_note` return semantic link candidates so an assistant can immediately
propose `[[wikilinks]]` — the capture → suggest → connect loop.
"""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ..embeddings_provider import build_embed_text, embed_query
from ..links import note_url, with_note_urls
from ._base import (
    FORBIDDEN,
    NOT_FOUND,
    UNAUTH,
    WRITE_ROLES,
    note_and_role,
    note_dict,
    resolve_user,
)
from .health import write_feedback

_READ = {"readOnlyHint": True, "openWorldHint": False}
_WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}

# Cosine similarity above which the top link candidate is surfaced as a
# probable duplicate of the just-created note. Conservative on purpose — it's
# a nudge for the assistant, not a block, and false alarms would teach
# assistants to ignore it.
_DUP_SCORE = 0.90


async def _candidates(note: "data.Note", limit: int = 8) -> list[dict]:
    """Best-effort link candidates for a freshly written note (never raises).
    Embeds the same text shape the worker stores (`build_embed_text`) so the
    scores are comparable to note-to-note similarity."""
    try:
        qvec = await embed_query(build_embed_text(note.title, note.body, note.tags, note.type))
        return with_note_urls(await data.neighbors_for_text(note.project_id, qvec, note.id, limit))
    except Exception:  # noqa: BLE001 — candidates are a nicety, not the write
        return []


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="Read a note", annotations=_READ)
    async def read_note(note_id: str) -> dict:
        """Fetch a note's full body, frontmatter metadata and backlinks.

        `can_edit` tells you whether write tools will be accepted for this note.
        `convention_hints` lists where the note departs from its workspace
        guide, and `review` (when the note sets `review_every`) says when it
        was last reviewed and whether it's overdue.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        backlinks = await data.get_backlinks(note.id)
        health = await data.note_health(note)
        return note_dict(
            note, backlinks=backlinks, can_edit=role in WRITE_ROLES,
            review=health["review"], convention_hints=health["hints"],
            guide_id=health["guide_id"],
        )

    @mcp.tool(title="Create a note", annotations=_WRITE)
    async def create_note(
        project_id: str,
        title: str,
        body: str = "",
        folder_id: str | None = None,
    ) -> dict:
        """Author a new markdown note in a workspace (editor+).

        Before creating, prefer `search` to check whether a note on the topic
        already exists — updating an existing note beats a near-copy.

        Body is standard markdown; `[[wikilinks]]` become graph edges and YAML
        frontmatter (type/tags/status) is parsed automatically. Fenced ``` code
        blocks are syntax-highlighted in the reading view — a ```language tag is
        optional (recall auto-detects) but more reliable for short snippets.
        Returns the note plus `link_candidates` — semantically similar notes you
        can link to.
        If the response also carries `possible_duplicate`, an existing note is
        near-identical to what you just wrote: read it, and prefer merging your
        content into it with `update_note` (then `delete` the redundant new
        note) unless the two genuinely need to stay separate.
        If it carries `convention_hints`, the note departs from the workspace
        guide (e.g. a misspelled tag) or has an unreadable `review_every`:
        fix it with `update_note` unless the user asked for it that way.

        Diagrams: put a ```mermaid fenced code block in the body and recall
        renders it (flowchart, sequence, class, state, ER, gantt, mindmap, …).
        Validate the diagram with `preview_diagram` first so it renders cleanly.

        Args:
            project_id: Target workspace.
            title: Note title (also seeds the slug).
            body: Markdown body, optionally with frontmatter, `[[wikilinks]]`,
                and ```mermaid diagram blocks.
            folder_id: Optional folder within the workspace.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        role = await data.get_membership_role(user.id, project_id)
        if role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        if folder_id is not None:
            folder = await data.get_folder(folder_id)
            if folder is None or folder.project_id != project_id:
                return {"error": "invalid_folder"}
        note = await data.create_note(
            project_id, (title or "Untitled").strip() or "Untitled",
            body or "", user.id, folder_id,
        )
        candidates = await _candidates(note)
        extra: dict = {"link_candidates": candidates}
        # Anti-fragmentation nudge: when the nearest existing note is this
        # similar, the assistant almost certainly just re-created it.
        if candidates and candidates[0]["score"] >= _DUP_SCORE:
            extra["possible_duplicate"] = candidates[0]
        extra.update(await write_feedback(note))
        return note_dict(note, **extra)

    @mcp.tool(title="Update a note", annotations=_WRITE)
    async def update_note(
        note_id: str,
        title: str | None = None,
        body: str | None = None,
        base_updated_at: str | None = None,
    ) -> dict:
        """Edit a note's title and/or body (editor+). Re-embeds, re-parses links
        and snapshots the prior version automatically. Body is standard markdown,
        including ```mermaid diagram blocks (validate with `preview_diagram`).

        Pass `base_updated_at` (the `updated_at` you last read) for a safe write:
        if someone edited in between you get `{"error":"conflict", "note": …}`
        with the current note instead of clobbering it. Returns the updated note
        plus refreshed `link_candidates`.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        try:
            updated = await data.update_note(
                note.id, title, body, user.id, base_updated_at=base_updated_at
            )
        except data.StaleUpdate:
            current = await data.get_note(note.id)
            return {"error": "conflict",
                    "note": note_dict(current) if current else None}
        return note_dict(updated, link_candidates=await _candidates(updated),
                         **await write_feedback(updated))

    @mcp.tool(title="Link one note to another", annotations=_WRITE)
    async def link_notes(note_id: str, target_title: str) -> dict:
        """Append a `[[wikilink]]` to `target_title` at the end of a note's body
        (editor+), then re-parse links so the edge (and its backlink) appears.

        The link lives in the markdown — the single source of truth — never as a
        hidden DB-only edge. `target_title` should match an existing note's title
        in the same workspace; an unresolved link is kept and resolves later if a
        matching note is created.
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        target = (target_title or "").strip()
        if not target:
            return {"error": "target_title_required"}
        if f"[[{target}]]" in note.body:
            return note_dict(note, already_linked=True)
        sep = "" if note.body.endswith("\n") or not note.body else "\n\n"
        new_body = f"{note.body}{sep}[[{target}]]\n"
        updated = await data.update_note(note.id, None, new_body, user.id)
        return note_dict(updated)

    # Not folded into `link_notes`: that tool APPENDS a link to any title
    # (even a dangling one) at the end of the body, whereas this one rewrites
    # an existing plain-text mention in place and needs the target's id to
    # find it. One tool per behaviour keeps both descriptions unambiguous.
    @mcp.tool(title="Link a plain-text mention", annotations=_WRITE)
    async def link_mention(note_id: str, source_note_id: str) -> dict:
        """Turn the first unlinked plain-text mention of note `note_id` inside
        note `source_note_id` into a `[[wikilink]]` (editor+ on the source; the
        target only needs read access). Find candidates with
        `unlinked_mentions`.

        The mention is rewritten in place: `[[Title]]` when it already reads
        exactly like the title, else `[[Title|text as written]]` so the prose is
        unchanged. Saved like any edit (version snapshot, link re-parse,
        re-embed), so the source now shows up in the target's backlinks.
        Returns the updated source note. Errors: `no_mention` (nothing left to
        link), `already_linked`, `conflict` (the source changed meanwhile —
        retry), `unlinkable_title`.

        Args:
            note_id: The note being mentioned (the link target).
            source_note_id: The note containing the mention (gets edited).
        """
        user = await resolve_user()
        if user is None:
            return UNAUTH
        target, role = await note_and_role(user, note_id)
        if target is None or role is None:
            return NOT_FOUND
        source, src_role = await note_and_role(user, source_note_id)
        if source is None or src_role is None:
            return NOT_FOUND
        if src_role not in WRITE_ROLES:
            return FORBIDDEN
        try:
            updated = await data.link_unlinked_mention(target.id, source.id, user.id)
        except data.MentionLinkError as e:
            return {"error": e.code}
        except data.StaleUpdate:
            return {"error": "conflict"}
        return note_dict(
            updated, linked_to={"id": target.id, "title": target.title,
                                "url": note_url(target.id)},
        )

    @mcp.tool(title="Save a version", annotations=_WRITE)
    async def save_version(note_id: str, label: str | None = None) -> dict:
        """Snapshot a note's current body as a labelled version (editor+), so it
        can be restored later from history."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        note, role = await note_and_role(user, note_id)
        if note is None or role is None:
            return NOT_FOUND
        if role not in WRITE_ROLES:
            return FORBIDDEN
        label = (label or "").strip() or None
        ok = await data.create_revision(note.id, user.id, label)
        if not ok:
            return NOT_FOUND
        return {"ok": True, "revisions": await data.list_revisions(note.id)}
