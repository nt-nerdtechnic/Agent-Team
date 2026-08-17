"""SQLite engine + schema setup."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine, inspect
from sqlmodel import SQLModel, create_engine

# Import models so their tables register on SQLModel.metadata.
from . import models  # noqa: F401


def create_db_engine(db_path: Path | str) -> Engine:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    _add_registry_signing_columns(engine)
    return engine


def _add_registry_signing_columns(engine: Engine) -> None:
    """Apply the additive trust columns to registries created before Issue 05."""
    columns = {
        column["name"] for column in inspect(engine).get_columns("extension_version")
    }
    statements = []
    if "target" not in columns:
        statements.append(
            "ALTER TABLE extension_version ADD COLUMN target VARCHAR "
            "NOT NULL DEFAULT 'universal'"
        )
    if "registry_envelope" not in columns:
        statements.append(
            "ALTER TABLE extension_version ADD COLUMN registry_envelope JSON "
            "NOT NULL DEFAULT '{}'"
        )
    if "registry_signature" not in columns:
        statements.append(
            "ALTER TABLE extension_version ADD COLUMN registry_signature VARCHAR"
        )
    if statements:
        with engine.begin() as connection:
            for statement in statements:
                connection.exec_driver_sql(statement)
