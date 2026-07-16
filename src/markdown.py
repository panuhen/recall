"""Markdown helpers: frontmatter parsing, metadata projection, wikilinks.

The full markdown (including frontmatter) is the source of truth; these
functions derive the queryable projection and links from it.
"""
from __future__ import annotations

import re
from typing import Any

import yaml

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
# Inline code span (CommonMark-ish, single line: no DOTALL) OR a wikilink.
# The span alternative wins when a `[[link]]` sits inside backticks, so both
# extract and rewrite treat it as example text, not a link. Group 1 = backtick
# run, group 2 = wikilink inner text (None when the span alternative matched).
# Multi-line inline spans are a documented non-goal.
_CODE_OR_WIKILINK_RE = re.compile(r"(`+).+?\1|\[\[([^\]]+)\]\]")

# A new title containing any of these can't round-trip inside `[[...]]`: `]`
# closes the link early, `[` nests, `|`/`#` re-parse as alias/anchor, and a
# backtick can pair with another in the surrounding text to swallow the link
# into a code span — so a rewritten `[[new title]]` would resolve to a
# *different* target or vanish from the index. Newlines additionally break the
# line-based fence scanner and YAML frontmatter. Renames to such titles skip
# the inbound-link cascade (the primary rename still happens; those inbound
# links just aren't auto-rewritten — no worse than pre-cascade).
UNSAFE_WIKILINK_TITLE_CHARS = frozenset("[]|#`\n\r")


def parse_frontmatter(body: str) -> tuple[dict[str, Any], str]:
    """Return (frontmatter dict, content-without-frontmatter)."""
    m = _FRONTMATTER_RE.match(body)
    if not m:
        return {}, body
    try:
        data = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return data, body[m.end() :]


def _iter_code_fence_segments(body: str):
    """Yield `(text, in_fence)` for maximal line runs, so wikilink handling can
    skip fenced code where `[[link]]` is example text, not a link. Simple
    line-based state machine: a line whose stripped content opens with 3+
    backticks or tildes toggles a fence; a same-char, same-or-longer marker
    closes it. Delimiter lines count as in-fence so rewrites leave them intact.
    `"".join(text for text, _ in ...) == body` (byte-exact reconstruction).
    Inline code spans are masked separately by _CODE_OR_WIKILINK_RE in the
    consumers below."""
    open_char, open_len, in_fence = "", 0, False
    buf: list[str] = []
    buf_flag = False
    for line in body.splitlines(keepends=True):
        stripped = line.strip()
        marker = None
        for ch in ("`", "~"):
            if stripped.startswith(ch * 3):
                marker = (ch, len(stripped) - len(stripped.lstrip(ch)))
                break
        if not in_fence:
            this_in = False
            if marker:  # opening delimiter — count it as part of the fence
                open_char, open_len = marker
                in_fence, this_in = True, True
        else:
            this_in = True  # inside a fence (incl. the closing delimiter line)
            if marker and marker[0] == open_char and marker[1] >= open_len:
                in_fence = False
        if buf and buf_flag == this_in:
            buf.append(line)
        else:
            if buf:
                yield "".join(buf), buf_flag
            buf, buf_flag = [line], this_in
    if buf:
        yield "".join(buf), buf_flag


def extract_wikilinks(body: str) -> list[str]:
    """Unique `[[Target]]` titles (drops `|alias` and `#heading`).

    Deliberately indexes EVERY wikilink, including ones inside code fences or
    backtick spans. This is the source of truth for `note_links` edges via
    _sync_links (delete-all-then-reinsert on each write), so the only safe
    failure direction is over-indexing: an extra backlink from a code example
    is harmless, whereas a scanner that mistook real prose for code would make
    the next save silently DROP live edges. Link-text *rewriting*
    (rewrite_wikilink_target) is code-aware — that's cosmetic and safe to get
    slightly wrong — but edge *indexing* stays blunt and lossless."""
    seen: dict[str, str] = {}
    for raw in _WIKILINK_RE.findall(body):
        title = raw.split("|", 1)[0].split("#", 1)[0].strip()
        if title:
            seen.setdefault(title.lower(), title)
    return list(seen.values())


def _valid_frontmatter_block(block: str) -> bool:
    """True when `block` is still a well-formed `---` frontmatter region whose
    YAML parses to a mapping (or nothing) — the shape parse_frontmatter can
    project without data loss."""
    m = _FRONTMATTER_RE.match(block)
    if not m:
        return False
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return False
    return isinstance(data or {}, dict)


def rewrite_wikilink_target(body: str, old_title: str, new_title: str) -> tuple[str, int]:
    """Rewrite `[[old_title]]` targets to `new_title`, keeping any `|alias` /
    `#anchor` suffix intact. Used to cascade a note rename into the link *text*
    of notes that reference it. Matches the target case-insensitively and
    tolerates whitespace inside the brackets.

    Wikilinks inside fenced code blocks or inline code spans are left
    byte-for-byte intact — a `[[link]]` in a code example is documentation, not
    a reference to rewrite. This is best-effort and independent of
    extract_wikilinks (which indexes everything): the code-fence/span scanner
    approximates CommonMark, so on pathological input the worst case is a link
    whose text isn't refreshed on rename (cosmetic — the edge still resolves by
    the immutable slug), never a lost edge.

    The YAML frontmatter region is rewritten too (its links rot like any other)
    but only kept when the result still parses to a mapping: a title like
    `Rock 'n' Roll` substituted into `related: '[[Old]]'` would break the YAML,
    and parse_frontmatter silently projects broken frontmatter as `{}` — wiping
    the note's type/tags/status. On validation failure the frontmatter region
    is reverted verbatim and its rewrites aren't counted.

    Returns (new_body, links_rewritten). Pure string op — no DB."""
    old = old_title.strip().lower()
    count = 0

    def _sub(m: re.Match[str]) -> str:
        nonlocal count
        inner = m.group(2)
        if inner is None:  # inline code span — leave verbatim
            return m.group(0)
        # Target = everything before the first `|` (alias) or `#` (anchor),
        # whichever comes first — the same split extract_wikilinks does.
        cut = min((i for i in (inner.find("|"), inner.find("#")) if i != -1),
                  default=len(inner))
        target, rest = inner[:cut], inner[cut:]
        if target.strip().lower() != old:
            return m.group(0)
        count += 1
        return f"[[{new_title}{rest}]]"  # rest keeps the alias/anchor verbatim

    fm, rest = "", body
    fm_match = _FRONTMATTER_RE.match(body)
    if fm_match:
        fm, rest = body[: fm_match.end()], body[fm_match.end() :]

    new_rest = "".join(
        text if in_fence else _CODE_OR_WIKILINK_RE.sub(_sub, text)
        for text, in_fence in _iter_code_fence_segments(rest)
    )

    new_fm = fm
    if fm:
        before = count
        candidate = _CODE_OR_WIKILINK_RE.sub(_sub, fm)
        if candidate != fm:
            if _valid_frontmatter_block(candidate):
                new_fm = candidate
            else:
                count = before  # revert — a broken block would wipe hot columns
    return new_fm + new_rest, count


def project_metadata(fm: dict[str, Any]) -> dict[str, Any]:
    """Split frontmatter into hot columns (type/tags/status) + leftover JSONB."""
    fm = dict(fm)
    type_ = fm.pop("type", None)
    status = fm.pop("status", None)
    tags = fm.pop("tags", None)

    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    elif isinstance(tags, list):
        tags = [str(t).strip() for t in tags if str(t).strip()]
    else:
        tags = []

    return {
        "type": str(type_) if type_ is not None else None,
        "status": str(status) if status is not None else None,
        "tags": tags,
        "metadata": fm,
    }


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title.strip().lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s or "untitled"
