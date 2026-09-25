"""Shareable web URLs for notes and workspaces, returned by the MCP tools so an
assistant can hand a person a link. Built from ``config.APP_URL``; ``None`` when
it isn't configured. A link grants nothing: opening it still needs access.
"""
from __future__ import annotations

from . import config


def note_url(note_id: str | None) -> str | None:
    if not config.APP_URL or not note_id:
        return None
    return f"{config.APP_URL}/notes/{note_id}"


def workspace_url(project_id: str | None) -> str | None:
    if not config.APP_URL or not project_id:
        return None
    return f"{config.APP_URL}/projects/{project_id}"


def with_note_urls(rows: list[dict]) -> list[dict]:
    """Add ``url`` to note rows (dicts keyed by ``id``) in place and return them."""
    for r in rows:
        r["url"] = note_url(r.get("id"))
    return rows


def with_workspace_urls(rows: list[dict]) -> list[dict]:
    """Add ``url`` to workspace rows (dicts keyed by ``id``) in place and return them."""
    for r in rows:
        r["url"] = workspace_url(r.get("id"))
    return rows
