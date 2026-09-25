"""Markdown helpers: frontmatter parsing, metadata projection, wikilinks.

The full markdown (including frontmatter) is the source of truth; these
functions derive the queryable projection and links from it.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass
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


def _json_safe(value: Any) -> Any:
    """YAML reads an unquoted `2026-09-25` as a date, which JSONB can't store.
    Turn dates (and anything else non-JSON) into strings, recursively."""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def project_metadata(fm: dict[str, Any]) -> dict[str, Any]:
    """Split frontmatter into hot columns (type/tags/status) + leftover JSONB."""
    fm = _json_safe(dict(fm))
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


def frontmatter_problem(body: str) -> str | None:
    """Why a note's frontmatter block can't be read, or None when it's fine or
    absent. parse_frontmatter silently treats a broken block as empty; this
    says what went wrong so it can be shown."""
    m = _FRONTMATTER_RE.match(body)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" on line {mark.line + 2}" if mark is not None else ""
        return f"The frontmatter isn't valid YAML{where}."
    if data is not None and not isinstance(data, dict):
        return "The frontmatter should be `key: value` lines."
    return None


def set_frontmatter_value(body: str, key: str, value: str) -> str | None:
    """Set one top-level scalar `key: value` in the frontmatter, creating the
    block when there is none. Other lines, comments and order are kept. `value`
    is written as-is, so pass valid YAML (e.g. an ISO date). Returns None when
    the existing frontmatter is broken, since editing it could lose data."""
    m = _FRONTMATTER_RE.match(body)
    line = f"{key}: {value}"
    if not m:
        return f"---\n{line}\n---\n{body}"
    if frontmatter_problem(body) is not None:
        return None
    lines = m.group(1).split("\n")
    key_re = re.compile(rf"^{re.escape(key)}[ \t]*:")
    for i, existing in enumerate(lines):
        if key_re.match(existing):
            end = i + 1  # drop a block value's continuation lines too
            while end < len(lines) and re.match(r"^(\s|-\s)", lines[end]):
                end += 1
            lines[i:end] = [line]
            break
    else:
        lines.append(line)
    new_body = "---\n" + "\n".join(lines) + "\n---\n" + body[m.end():]
    return new_body if _valid_frontmatter_block(new_body) else None


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title.strip().lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s or "untitled"


# ── Unlinked mentions ───────────────────────────────────────
# Plain-text occurrences of a note's title (or a frontmatter alias) in another
# note's prose, for the "Unlinked mentions" surface and its one-click linker.
# Pure string ops; the SQL prefilter and the edit live in data.py.

# Single-word titles too generic to be worth surfacing as mentions. Matched
# case-insensitively against whole terms only (a phrase like "Meeting notes"
# is kept). Keep it short: every entry hides real mentions of such a note.
MENTION_STOPWORDS = frozenset(
    {"note", "notes", "test", "todo", "untitled", "draft", "idea", "misc"}
)
MENTION_MIN_LEN = 3

# Regions of a (non-fenced) segment where a mention is not plain prose. Inline
# code comes first so a `[[link]]` inside backticks stays code, as in
# _CODE_OR_WIKILINK_RE. MULTILINE is for the reference-definition line anchor.
_MENTION_MASK_RE = re.compile(
    r"(`+).+?\1"                           # inline code span
    r"|\[\[[^\]]+\]\]"                     # existing [[wikilink]]
    r"|!?\[[^\]\n]*\]\([^)\n]*\)"          # [text](url) / ![alt](src)
    r"|!?\[[^\]\n]*\]\[[^\]\n]*\]"         # [text][ref]
    r"|^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*$"    # [ref]: url  (reference definition)
    r"|<[A-Za-z/][^>\n]*>"                 # <https://autolink> / <html tag>
    r"|(?:https?|ftp)://[^\s<>()\[\]]+",   # bare URL
    re.MULTILINE,
)


def mention_terms(title: str, metadata: dict | None) -> list[str]:
    """The phrases that count as a mention of a note: its title plus any
    frontmatter `aliases:` (a list of strings or a single string). Whitespace
    is collapsed; terms shorter than MENTION_MIN_LEN, without any word
    character, single words in MENTION_STOPWORDS, or containing characters
    that can't sit inside `[[...]]` are dropped. Case-insensitively unique,
    title first. Returns [] when the title itself can't be written as a
    wikilink target (no link could be made)."""
    title = title or ""
    if not title.strip() or set(title) & UNSAFE_WIKILINK_TITLE_CHARS:
        return []
    raw = [title]
    aliases = (metadata or {}).get("aliases")
    if isinstance(aliases, str):
        raw.append(aliases)
    elif isinstance(aliases, list):
        raw.extend(a for a in aliases if isinstance(a, str))
    out: dict[str, str] = {}
    for t in raw:
        t = " ".join(t.split())
        if len(t) < MENTION_MIN_LEN or not re.search(r"\w", t):
            continue
        if set(t) & UNSAFE_WIKILINK_TITLE_CHARS:
            continue
        if " " not in t and t.lower() in MENTION_STOPWORDS:
            continue
        out.setdefault(t.lower(), t)
    return list(out.values())


def mention_masked_spans(body: str) -> list[tuple[int, int]]:
    """Sorted `(start, end)` offsets of `body` that are NOT plain prose for
    mention purposes: the frontmatter block, fenced code blocks (incl. their
    delimiter lines), inline code, existing wikilinks, markdown link text and
    URLs, reference definitions, autolinks/HTML tags and bare URLs."""
    spans: list[tuple[int, int]] = []
    start = 0
    fm = _FRONTMATTER_RE.match(body)
    if fm:
        spans.append((0, fm.end()))
        start = fm.end()
    pos = start
    for text, in_fence in _iter_code_fence_segments(body[start:]):
        end = pos + len(text)
        if in_fence:
            spans.append((pos, end))
        else:
            spans.extend(m.span() for m in _MENTION_MASK_RE.finditer(body, pos, end))
        pos = end
    return spans


@dataclass(frozen=True)
class Mention:
    start: int
    end: int
    text: str  # the matched text as written in the body
    term: str  # the title/alias it matched


class MentionMatcher:
    """Finds whole-word, case-insensitive occurrences of any term in prose.

    Word boundaries are explicit Unicode lookarounds (`(?<!\\w)` / `(?!\\w)`,
    `str` patterns are Unicode by default), so "worker" never matches inside
    "coworker" or "workers" and Finnish/accented letters count as letters.
    Words in a multi-word term may be separated by any run of spaces/tabs (not
    newlines). Longer terms are tried first so the longest phrase wins at a
    position. No stemming."""

    def __init__(self, terms: list[str]):
        self.terms = list(terms)
        self._by_key = {" ".join(t.lower().split()): t for t in self.terms}
        ordered = sorted(self.terms, key=len, reverse=True)
        alts = [r"[^\S\n]+".join(re.escape(w) for w in t.split()) for t in ordered]
        self._re = (
            re.compile(r"(?<!\w)(?:" + "|".join(alts) + r")(?!\w)", re.IGNORECASE)
            if alts else None
        )

    def prefilter_needles(self) -> list[str]:
        """One lowercase substring per term that every match must contain (its
        longest word) — for a cheap `strpos(lower(body), …)` SQL prefilter."""
        return sorted({max(t.lower().split(), key=len) for t in self.terms})

    def first(self, body: str) -> Mention | None:
        """The first mention of any term in `body` outside the masked regions
        (see mention_masked_spans), or None."""
        if self._re is None:
            return None
        spans = mention_masked_spans(body)
        pos = 0
        while pos <= len(body):
            m = self._re.search(body, pos)
            if m is None:
                return None
            s, e = m.span()
            hit = next((sp for sp in spans if sp[0] < e and s < sp[1]), None)
            if hit is None:
                text = m.group(0)
                term = self._by_key.get(" ".join(text.lower().split()), text)
                return Mention(s, e, text, term)
            # Inside a masked region: resume after it. Straddling its start:
            # retry one character on (a shorter term may still fit before it).
            pos = hit[1] if s >= hit[0] else s + 1
        return None


def mention_snippet(body: str, start: int, end: int, width: int = 120) -> str:
    """~`width` characters of context around `body[start:end]`, kept within
    the enclosing paragraph (and after any frontmatter), snapped to word
    boundaries and whitespace-collapsed. Ellipses mark trimmed ends."""
    fm = _FRONTMATTER_RE.match(body)
    floor = fm.end() if fm else 0
    para_start = body.rfind("\n\n", floor, start)
    lo = para_start + 2 if para_start != -1 else floor
    para_end = body.find("\n\n", end)
    hi = para_end if para_end != -1 else len(body)
    side = max(0, (width - (end - start)) // 2)
    a, b = max(lo, start - side), min(hi, end + side)
    if a > lo:
        sp = body.find(" ", a, start)
        a = sp + 1 if sp != -1 else a
    if b < hi:
        sp = body.rfind(" ", end, b)
        b = sp if sp != -1 else b
    text = " ".join(body[a:b].split())
    return ("…" if a > lo else "") + text + ("…" if b < hi else "")


def mention_link_text(title: str, mention: Mention, body: str) -> str:
    """The wikilink that replaces `mention`: `[[Title]]` when the matched text
    is exactly the title, else `[[Title|matched text]]` so the prose reads the
    same. Inside a GFM table row the `|` would split the cell, so there it's
    always `[[Title]]`."""
    if mention.text == title:
        return f"[[{title}]]"
    line_start = body.rfind("\n", 0, mention.start) + 1
    if body[line_start:mention.start].lstrip().startswith("|"):
        return f"[[{title}]]"
    return f"[[{title}|{mention.text}]]"
