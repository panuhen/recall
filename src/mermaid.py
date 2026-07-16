"""Lightweight Mermaid syntax validation (no browser required).

A structural sanity check used by the `preview_diagram` MCP tool so an assistant
can catch the common mistakes — unknown/missing diagram type, unbalanced
brackets/parentheses, empty source — before writing a ```mermaid block into a
note. It is intentionally NOT a full Mermaid parse (that needs the JS engine),
so it will not catch every semantic error; it catches the ones models make most.
"""
from __future__ import annotations

import re

_FENCE_RE = re.compile(
    r"^\s*```+[ \t]*mermaid[ \t]*\r?\n(?P<body>.*?)\r?\n?\s*```+\s*$",
    re.DOTALL | re.IGNORECASE,
)

# Recognized diagram-type headers (the first keyword of a Mermaid diagram).
_TYPES = {
    "graph", "flowchart", "sequencediagram", "classdiagram", "statediagram",
    "statediagram-v2", "erdiagram", "journey", "gantt", "pie", "quadrantchart",
    "requirementdiagram", "gitgraph", "mindmap", "timeline", "sankey-beta",
    "xychart-beta", "block-beta", "packet-beta", "kanban", "architecture-beta",
    "c4context", "c4container", "c4component", "c4dynamic", "c4deployment",
    "radar", "treemap", "zenuml",
}

_PAIRS = {")": "(", "]": "[", "}": "{"}
_OPEN = frozenset("([{")

# The diagram keywords surfaced to an assistant when the type is unrecognized.
_HINT_TYPES = (
    "flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, "
    "gantt, pie, mindmap, timeline, journey, gitGraph"
)


def _strip_fence(src: str) -> str:
    """Return the diagram body, unwrapping a single ```mermaid fence if present."""
    m = _FENCE_RE.match(src.strip())
    return m.group("body") if m else src


def _meaningful_lines(src: str) -> list[str]:
    """Non-blank lines that aren't `%%` comments / `%%{init}%%` directives."""
    out: list[str] = []
    for raw in src.splitlines():
        line = raw.strip()
        if line and not line.startswith("%%"):
            out.append(line)
    return out


def _detect_type(lines: list[str]) -> str | None:
    """The first diagram-type token, skipping a leading `--- … ---` config block."""
    i, n = 0, len(lines)
    if i < n and lines[i] == "---":  # YAML frontmatter config block
        i += 1
        while i < n and lines[i] != "---":
            i += 1
        i += 1  # step past the closing ---
    if i >= n:
        return None
    head = re.split(r"[\s(){:;]", lines[i], maxsplit=1)[0].lower()
    return head or None


def _bracket_error(src: str) -> str | None:
    """First unbalanced-bracket problem, ignoring quoted spans and `%%` comments.

    Mermaid strings don't span lines, so quote state resets each line.
    """
    stack: list[str] = []
    for line in src.splitlines():
        in_str = False
        quote = ""
        i, length = 0, len(line)
        while i < length:
            ch = line[i]
            if in_str:
                if ch == quote:
                    in_str = False
            elif ch in ('"', "'"):
                in_str, quote = True, ch
            elif line[i : i + 2] == "%%":
                break  # rest of the line is a comment
            elif ch in _OPEN:
                stack.append(ch)
            elif ch in _PAIRS:
                if not stack or stack[-1] != _PAIRS[ch]:
                    return (
                        f"Unbalanced '{ch}'. Check that brackets and "
                        f"parentheses match."
                    )
                stack.pop()
            i += 1
    if stack:
        opened = "', '".join(dict.fromkeys(stack))
        return f"Unclosed '{opened}'. Check that brackets and parentheses match."
    return None


def validate_mermaid(source: str) -> dict:
    """Structurally validate a Mermaid diagram. Accepts raw source or a fenced
    ```mermaid block. Returns {ok, diagram_type, errors, warnings}."""
    src = _strip_fence(source or "")
    lines = _meaningful_lines(src)
    errors: list[str] = []
    warnings: list[str] = []

    if not lines:
        return {
            "ok": False,
            "diagram_type": None,
            "errors": ["The diagram is empty."],
            "warnings": [],
        }

    dtype = _detect_type(lines)
    known = bool(dtype) and dtype in _TYPES
    if not known:
        lead = f"Unrecognized diagram type {dtype!r}. " if dtype else "No diagram type found. "
        errors.append(
            f"{lead}The first line must name a Mermaid diagram, e.g.: {_HINT_TYPES}."
        )

    bracket = _bracket_error(src)
    if bracket:
        errors.append(bracket)

    return {
        "ok": not errors,
        "diagram_type": dtype if known else None,
        "errors": errors,
        "warnings": warnings,
    }
