"""Workspace guide conventions and per-note review.

Everything is flat frontmatter, so any markdown tool (Obsidian's Properties,
recall's Properties, a text editor) can read and edit it.

A note can say how often it should be checked:

    owner: someone@example.com
    review_every: 6mo        # or 6 months, 2w, 30 days, 1y, quarterly, …
    reviewed: 2026-09-25     # set by "Mark as reviewed"

`review_every` is read leniently and never rewritten: the file keeps what the
person typed, and recall only interprets it.

A workspace can have one guide note (`type: guide`). Its body is prose for
people and agents ("runbooks have an owner and are reviewed every 6 months");
its frontmatter lists the note types and tags the workspace uses:

    type: guide
    owner: someone@example.com
    workspace_types: [runbook, decision, note]
    workspace_tags: [infra, auth, search]

Everything here is advisory: hints never block a save. A guide with a
formatting problem counts as no conventions, and the problem is shown so the
owner can fix it. Pure functions; the SQL lives in data.py.
"""
from __future__ import annotations

import calendar
import difflib
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

GUIDE_TYPE = "guide"
TYPES_KEY = "workspace_types"
TAGS_KEY = "workspace_tags"

# `<n> <unit>`, optionally prefixed with "every"; the number defaults to 1
# ("every month"). Units map onto d / w / mo / y. A bare `m` means months:
# minutes make no sense for a review cadence.
_DURATION_RE = re.compile(r"^(?:every\s+)?(?:(\d+)\s*)?([a-z]+)$")
_UNITS = {
    **dict.fromkeys(("d", "day", "days"), "d"),
    **dict.fromkeys(("w", "wk", "wks", "week", "weeks"), "w"),
    **dict.fromkeys(("m", "mo", "mos", "mth", "mths", "month", "months"), "mo"),
    **dict.fromkeys(("y", "yr", "yrs", "year", "years"), "y"),
}
_KEYWORDS = {
    "daily": (1, "d"),
    "weekly": (1, "w"),
    "biweekly": (2, "w"),
    "fortnightly": (2, "w"),
    "monthly": (1, "mo"),
    "quarterly": (3, "mo"),
    "yearly": (1, "y"),
    "annually": (1, "y"),
    "annual": (1, "y"),
}
_UNIT_WORDS = {"d": "day", "w": "week", "mo": "month", "y": "year"}


@dataclass
class Conventions:
    owner: str | None = None
    types: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"owner": self.owner, "types": self.types, "tags": self.tags}


# ── Durations ───────────────────────────────────────────────


def parse_duration(text) -> tuple[int, str] | None:
    """A review period as people write it → (n, unit) with unit d / w / mo / y:
    `6mo`, `6M`, `6 months`, `every 2 weeks`, `30d`, `1 year`, `quarterly`.
    None when it can't be read or is zero."""
    if not isinstance(text, str):
        return None
    t = " ".join(text.strip().lower().split())
    if t in _KEYWORDS:
        return _KEYWORDS[t]
    m = _DURATION_RE.match(t)
    if not m or m.group(2) not in _UNITS:
        return None
    n = int(m.group(1)) if m.group(1) else 1
    return (n, _UNITS[m.group(2)]) if n > 0 else None


def canonical_duration(text) -> str | None:
    """`"6 months"` → `"6mo"`: the short form, for display and comparison."""
    parsed = parse_duration(text)
    return f"{parsed[0]}{parsed[1]}" if parsed else None


def describe_duration(text: str) -> str:
    """For "every …": `"6mo"` → "6 months", `"1y"` → "year"."""
    n, unit = parse_duration(text) or (0, "d")
    word = _UNIT_WORDS[unit]
    return word if n == 1 else f"{n} {word}s"


def add_duration(start: date, text: str) -> date:
    n, unit = parse_duration(text)  # type: ignore[misc]  # validated upstream
    if unit == "d":
        return start + timedelta(days=n)
    if unit == "w":
        return start + timedelta(weeks=n)
    months = n if unit == "mo" else n * 12
    y, m = divmod(start.month - 1 + months, 12)
    y, m = start.year + y, m + 1
    return date(y, m, min(start.day, calendar.monthrange(y, m)[1]))


def as_date(value) -> date | None:
    """A frontmatter value (ISO string, date, datetime) → date, else None."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


# ── Parsing the guide ───────────────────────────────────────


def _str_list(value, key: str, problems: list[str]) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):  # `workspace_tags: infra` — one item is fine
        value = [value]
    if not isinstance(value, list) or not all(
        isinstance(v, (str, int, float)) and not isinstance(v, bool) for v in value
    ):
        problems.append(f"`{key}` should be a list, like [a, b].")
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def parse_conventions(fm: dict) -> tuple[Conventions, list[str]]:
    """Read conventions from a guide's frontmatter (`owner`, `workspace_types`,
    `workspace_tags`; other keys are the guide's own properties). Returns the
    conventions and problems in plain words. Callers treat any problem as "no
    conventions"."""
    problems: list[str] = []
    conv = Conventions()
    owner = fm.get("owner")
    if owner is not None:
        if isinstance(owner, (str, int, float)) and not isinstance(owner, bool):
            conv.owner = str(owner).strip() or None
        else:
            problems.append("`owner` should be a name or an email address.")
    conv.types = _str_list(fm.get(TYPES_KEY), TYPES_KEY, problems)
    conv.tags = _str_list(fm.get(TAGS_KEY), TAGS_KEY, problems)
    return conv, problems


# ── Checking a note ─────────────────────────────────────────


def _closest(value: str, options: list[str]) -> str | None:
    """The declared option `value` was most likely meant as, or None. Catches
    typos (difflib) and longer or shorter forms of the same word
    ("infrastructure" → "infra")."""
    low = value.lower()
    by_lower = {o.lower(): o for o in options}
    if low in by_lower:
        return None  # only case differs; not worth a hint
    close = difflib.get_close_matches(low, list(by_lower), n=1, cutoff=0.75)
    if close:
        return by_lower[close[0]]
    for o_low, o in by_lower.items():
        if len(o_low) >= 3 and len(low) >= 3 and (low.startswith(o_low) or o_low.startswith(low)):
            return o
    return None


def check_review_every(metadata: dict) -> list[dict]:
    """A hint when the note's own `review_every` can't be read. Applies with or
    without a guide."""
    value = metadata.get("review_every")
    if value in (None, "") or parse_duration(str(value)) is not None:
        return []
    return [{
        "code": "review_every_invalid",
        "field": "review_every",
        "message": f"`review_every: {value}` isn't a period recall understands. "
                   "Use something like 2w, 30d, 6mo, 6 months or 1y.",
    }]


def check_note(conv: Conventions, note_type, tags) -> list[dict]:
    """The guide's hints for one note: `{code, field, message}`. Only close
    misspellings of declared tags get a hint (unrelated tags are fine); an
    undeclared type always does, since the list is short."""
    if note_type == GUIDE_TYPE:
        return []
    hints: list[dict] = []
    if conv.tags:
        declared = {t.lower() for t in conv.tags}
        for tag in tags or []:
            if tag.lower() in declared:
                continue
            guess = _closest(tag, conv.tags)
            if guess:
                hints.append({
                    "code": "tag_not_declared",
                    "field": "tags",
                    "message": f"`{tag}` isn't a tag here. Did you mean `{guess}`?",
                })
    if note_type and conv.types and note_type.lower() not in {t.lower() for t in conv.types}:
        guess = _closest(note_type, conv.types)
        hints.append({
            "code": "type_not_declared",
            "field": "type",
            "message": (
                f"`{note_type}` isn't a type here. Did you mean `{guess}`?"
                if guess
                else f"`{note_type}` isn't a type here. This workspace uses: "
                     f"{', '.join(conv.types)}."
            ),
        })
    return hints


def review_state(metadata: dict, created: date, today: date) -> dict | None:
    """From the note's own `review_every` and `reviewed`: the last review,
    when the next one is due and whether it's overdue. A note never reviewed
    counts from its creation date. None when it has no (valid) interval."""
    every = canonical_duration(str(metadata.get("review_every") or ""))
    if every is None:
        return None
    reviewed = as_date(metadata.get("reviewed"))
    due = add_duration(reviewed or created, every)
    return {
        "every": every,
        "every_text": describe_duration(every),
        "reviewed": reviewed.isoformat() if reviewed else None,
        "due": due.isoformat(),
        "overdue": today >= due,
    }


def owner_matches(owner: str, members: list[dict]) -> bool:
    """Whether a free-text `owner:` names a current member (email or display
    name, case-insensitive)."""
    o = owner.strip().lower()
    return any(
        o in {(m.get("upn") or "").lower(), (m.get("display_name") or "").lower()}
        for m in members
    )


# ── Starter guide ───────────────────────────────────────────

_PLAIN_YAML = re.compile(r"^[A-Za-z0-9_][\w.@/-]*$")


def _yaml_scalar(s: str) -> str:
    """Bare when that reads back as the same string, else double-quoted."""
    plain = _PLAIN_YAML.match(s) and s.lower() not in {
        "true", "false", "yes", "no", "on", "off", "null", "y", "n",
    } and not re.match(r"^[\d.+-]", s)
    return s if plain else '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _yaml_list(items: list[str]) -> str:
    return "[" + ", ".join(_yaml_scalar(i) for i in items) + "]"


def starter_guide_body(owner: str | None, types: list[str], tags: list[str]) -> str:
    """A first guide note built from what the workspace already uses: flat
    frontmatter plus headings to fill in."""
    lines = ["---", "type: guide"]
    if owner:
        lines.append(f"owner: {_yaml_scalar(owner)}")
    lines.append(f"{TYPES_KEY}: {_yaml_list(types)}")
    lines.append(f"{TAGS_KEY}: {_yaml_list(tags)}")
    lines.append("---")
    lines += [
        "## Purpose",
        "",
        "What this workspace is for.",
        "",
        "## Who it's for",
        "",
        "## How we write here",
        "",
        "Which note types to use and what each one should have. For example:",
        "runbooks have an `owner:` and `review_every: 6mo`, so they show up",
        "on the workspace page when a review is due.",
        "",
    ]
    return "\n".join(lines)
