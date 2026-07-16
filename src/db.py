"""Database migration helper.

Alembic runs raw SQL migrations (no ORM). The runtime uses asyncpg directly
(added in a later phase); Alembic uses SQLAlchemy + psycopg2 synchronously.
"""
from __future__ import annotations

import logging

from alembic import command
from alembic.config import Config

log = logging.getLogger("recall.db")


def run_migrations() -> None:
    """Apply all pending Alembic migrations (idempotent)."""
    log.info("Applying database migrations (alembic upgrade head)...")
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")
    log.info("Migrations applied.")
