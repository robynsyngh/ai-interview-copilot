"""TranscriptSegment - one chunk of text emitted by Deepgram for a session."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlmodel import Column, DateTime, Field, ForeignKey, SQLModel
from sqlmodel import Enum as SQLEnum


class Speaker(StrEnum):
    CANDIDATE = "candidate"
    INTERVIEWER = "interviewer"
    UNKNOWN = "unknown"


class TranscriptSegment(SQLModel, table=True):
    __tablename__ = "transcript_segment"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    session_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("interview_session.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
    )

    speaker: Speaker = Field(
        default=Speaker.UNKNOWN,
        sa_column=Column(SQLEnum(Speaker), nullable=False),
    )
    text: str = Field(default="")
    start_ms: int = Field(default=0)
    end_ms: int = Field(default=0)
    is_final: bool = Field(default=False)

    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
