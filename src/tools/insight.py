"""Insight tools: tags and the knowledge graph."""
from __future__ import annotations

from fastmcp import FastMCP

from .. import data
from ._base import NOT_FOUND, UNAUTH, resolve_user

_READ = {"readOnlyHint": True, "openWorldHint": False}


def register(mcp: FastMCP) -> None:
    @mcp.tool(title="List tags", annotations=_READ)
    async def list_tags(project_id: str) -> dict:
        """Tags used in a workspace with note counts, most-used first."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        return {"tags": await data.list_tags(project_id)}

    @mcp.tool(title="Knowledge graph", annotations=_READ)
    async def graph(project_id: str | None = None) -> dict:
        """Nodes + links of the knowledge graph. Pass `project_id` for a single
        workspace's note graph; omit it for the whole-account structure graph
        across every workspace you can see."""
        user = await resolve_user()
        if user is None:
            return UNAUTH
        if project_id is None:
            return await data.get_root_graph(user.id)
        if await data.get_membership_role(user.id, project_id) is None:
            return NOT_FOUND
        return await data.get_graph(project_id)
