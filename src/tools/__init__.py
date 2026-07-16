"""MCP tools for recall.

Each module exposes a `register(mcp)` that attaches its `@mcp.tool`s. Tools are
thin wrappers over `data.py` — the same query layer the REST API uses — and gate
access with the same `get_membership_role` check, so an assistant sees and edits
exactly what the signed-in user can. `register_tools` wires them all up.
"""
from __future__ import annotations

from fastmcp import FastMCP

from .diagram import register as register_diagram
from .history import register as register_history
from .insight import register as register_insight
from .members import register as register_members
from .notes import register as register_notes
from .organize import register as register_organize
from .search import register as register_search
from .trash import register as register_trash


def register_tools(mcp: FastMCP) -> None:
    register_search(mcp)
    register_notes(mcp)
    register_organize(mcp)
    register_members(mcp)
    register_trash(mcp)
    register_insight(mcp)
    register_history(mcp)
    register_diagram(mcp)
