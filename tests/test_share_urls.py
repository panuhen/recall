"""Shareable `url`s on MCP tool responses (src/links.py + the tool serializers)."""
from __future__ import annotations

import importlib

import pytest
from fastmcp import FastMCP

from src import config, data, links
from src.tools import organize as organize_tools

APP = "https://recall.example.com"


def _async_return(value):
    async def _f(*args, **kwargs):
        return value

    return _f


@pytest.fixture
def app_url(monkeypatch):
    monkeypatch.setattr(config, "APP_URL", APP)


def test_urls_built_from_app_url(app_url):
    assert links.note_url("n1") == f"{APP}/notes/n1"
    assert links.workspace_url("p1") == f"{APP}/projects/p1"
    rows = links.with_note_urls([{"id": "a"}, {"id": "b"}])
    assert [r["url"] for r in rows] == [f"{APP}/notes/a", f"{APP}/notes/b"]


def test_urls_null_without_app_url(monkeypatch):
    monkeypatch.setattr(config, "APP_URL", "")
    assert links.note_url("n1") is None
    assert links.workspace_url("p1") is None
    assert links.with_workspace_urls([{"id": "p"}]) == [{"id": "p", "url": None}]


def test_app_url_falls_back_to_better_auth_url_and_trims_slash(monkeypatch):
    monkeypatch.delenv("APP_URL", raising=False)
    monkeypatch.setenv("BETTER_AUTH_URL", "https://auth.example.com/")
    try:
        assert importlib.reload(config).APP_URL == "https://auth.example.com"
        monkeypatch.setenv("APP_URL", "https://app.example.com/")
        assert importlib.reload(config).APP_URL == "https://app.example.com"
    finally:
        monkeypatch.delenv("APP_URL", raising=False)
        monkeypatch.delenv("BETTER_AUTH_URL", raising=False)
        importlib.reload(config)


async def test_read_note_and_search_return_note_urls(
    app_url, monkeypatch, tool_fn, make_user, make_project
):
    user = await make_user()
    proj = await make_project(user)
    note = await data.create_note(proj.id, "Shareable", "find me by keyword", user.id)
    monkeypatch.setattr("src.tools.notes.resolve_user", _async_return(user))
    monkeypatch.setattr("src.tools.search.resolve_user", _async_return(user))

    read = await (await tool_fn("read_note"))(note_id=note.id)
    assert read["url"] == f"{APP}/notes/{note.id}"

    found = await (await tool_fn("search"))(query="keyword")
    assert found["results"] and found["results"][0]["url"] == f"{APP}/notes/{note.id}"

    listed = await (await tool_fn("query_notes"))(project_id=proj.id)
    assert listed["notes"][0]["url"] == f"{APP}/notes/{note.id}"


async def test_workspace_tools_return_workspace_urls(
    app_url, monkeypatch, make_user, make_project
):
    user = await make_user()
    proj = await make_project(user)
    await data.create_note(proj.id, "In tree", "", user.id)
    monkeypatch.setattr("src.tools.organize.resolve_user", _async_return(user))
    mcp = FastMCP("test")
    organize_tools.register(mcp)

    projects = (await (await mcp.get_tool("list_projects")).fn())["projects"]
    assert {p["id"]: p["url"] for p in projects}[proj.id] == f"{APP}/projects/{proj.id}"

    tree = await (await mcp.get_tool("list_tree")).fn(project_id=proj.id)
    assert all(n["url"] == f"{APP}/notes/{n['id']}" for n in tree["notes"])

    created = await (await mcp.get_tool("create_workspace")).fn(name="Linked")
    assert created["url"] == f"{APP}/projects/{created['id']}"
