"""Harness smoke test: the test DB is wired up and isolated correctly."""
from __future__ import annotations

from src import data


async def test_connected_to_test_db(db_pool):
    assert await db_pool.fetchval("SELECT current_database()") == "recall_test"


async def test_factories_and_truncation(db_pool, make_user, make_project):
    user = await make_user(name="Ada")
    proj = await make_project(user, name="Notebook")
    assert proj.role == "owner"
    # Tables start empty each test (truncation), so exactly what we made is here.
    assert await db_pool.fetchval("SELECT count(*) FROM users") == 1
    assert await db_pool.fetchval("SELECT count(*) FROM projects") == 1
    role = await data.get_membership_role(user.id, proj.id)
    assert role == "owner"
