"""InterviewSession - the root entity for one interview run."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlmodel import Column, DateTime, Field, SQLModel
from sqlmodel import Enum as SQLEnum


class SessionStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"


class AssistMode(StrEnum):
    """Whose side the co-pilot is assisting.

    - INTERVIEWER: produce evaluation rubrics for questions the interviewer asks.
    - INTERVIEWEE: produce the actual answer the candidate should say.
    """

    INTERVIEWER = "interviewer"
    INTERVIEWEE = "interviewee"


class InterviewSession(SQLModel, table=True):
    __tablename__ = "interview_session"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    candidate_name: str | None = Field(default=None, max_length=200)
    job_description: str = Field(default="")
    resume_text: str = Field(default="")
    # Stored as a plain string (not a DB enum) so adding/extending modes does not
    # require a Postgres enum-type migration.
    mode: str = Field(default=AssistMode.INTERVIEWER.value, max_length=20)
    status: SessionStatus = Field(
        default=SessionStatus.PENDING,
        sa_column=Column(SQLEnum(SessionStatus), nullable=False),
    )

    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    completed_at: datetime | None = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True),
    )
