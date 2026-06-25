"""SQLModel engine + session helpers for the D1 (PostgreSQL) data store."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

_settings = get_settings()

engine = create_engine(
    _settings.database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)


def init_db() -> None:
    """Create tables for any SQLModel that has been imported.

    For the skeleton we use `SQLModel.metadata.create_all`; once we start
    iterating on schema changes we can swap to Alembic migrations.
    """
    # Import models so they register against SQLModel.metadata before create_all.
    from app.models import (  # noqa: F401  (side-effect import)
        hint,
        report,
        session,
        transcript,
    )

    SQLModel.metadata.create_all(engine)
    _run_lightweight_migrations()


def _run_lightweight_migrations() -> None:
    """Idempotent in-place schema patches for the dev/skeleton setup.

    `create_all` never ALTERs existing tables, so columns added after a table
    already exists must be patched in here until we adopt Alembic.
    """
    statements = [
        "ALTER TABLE interview_session "
        "ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'interviewer'",
        "ALTER TABLE final_report "
        "ADD COLUMN IF NOT EXISTS technical_analysis TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE final_report "
        "ADD COLUMN IF NOT EXISTS communication_analysis TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE final_report "
        "ADD COLUMN IF NOT EXISTS culture_analysis TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE final_report "
        "ADD COLUMN IF NOT EXISTS recommendation_rationale TEXT NOT NULL DEFAULT ''",
    ]
    with engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))


def get_session() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a short-lived DB session."""
    with Session(engine) as session:
        yield session
