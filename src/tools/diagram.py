"""Diagram tool: validate Mermaid before it goes into a note.

`preview_diagram` is a pure, stateless syntax check (it touches no project data),
so — like `ping` — it carries no membership gate. It exists to close the loop for
an assistant authoring diagrams: write → validate → fix → save.
"""
from __future__ import annotations

from fastmcp import FastMCP

from ..mermaid import validate_mermaid

_READ = {"readOnlyHint": True, "openWorldHint": False}


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="Validate a Mermaid diagram", annotations=_READ)
    def preview_diagram(source: str) -> dict:
        """Check a Mermaid diagram's syntax before embedding it in a note.

        recall renders diagrams from ```mermaid fenced code blocks in a note's
        markdown body (both the reading view and the live editor). Call this to
        catch the common mistakes — unknown or missing diagram type, unbalanced
        brackets/parentheses, empty source — and fix them BEFORE create_note /
        update_note, so the saved diagram renders cleanly for the reader.

        Pass either the raw diagram source or a full ```mermaid fenced block.
        Returns `{ok, diagram_type, errors, warnings}`. This is a fast structural
        check, not a full render, so `ok: true` means "no obvious problems", not
        a guarantee every semantic detail is valid.

        Args:
            source: Mermaid diagram source, with or without the ```mermaid fence.
        """
        return validate_mermaid(source)
