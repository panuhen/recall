"""Alembic environment — reads DATABASE_URL from the environment.

Migrations are raw SQL via op.execute(); there is no ORM metadata to autogen.
"""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config

# The alembic CLI configures logging from alembic.ini. When the app runs the
# migrations (db.run_migrations) it opts out: fileConfig would otherwise reset
# the root level and disable every already-created `recall.*` logger.
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)


def _db_url() -> str:
    url = os.environ.get("DATABASE_URL", "postgresql://recall:recall@localhost:54324/recall")
    # Alembic runs synchronously via SQLAlchemy + psycopg2.
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)
    return url


config.set_main_option("sqlalchemy.url", _db_url())


def run_migrations_offline() -> None:
    context.configure(
        url=_db_url(),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
