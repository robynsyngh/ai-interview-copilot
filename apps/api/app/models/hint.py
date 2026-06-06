"""AIHint - one piece of real-time guidance produced by P5 (GitHub Models)."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlmodel import Column, DateTime, Field, ForeignKey, SQLModel
from sqlmodel import Enum as SQLEnum


class HintKind(StrEnum):
    FOLLOW_UP_QUESTION = "follow_up_question"
    CLARIFYING_PROMPT = "clarifying_prompt"
    RED_FLAG = "red_flag"
    STRENGTH_SIGNAL = "strength_signal"
    SCORE_UPDATE = "score_update"


class AIHint(SQLModel, table=True):
    __tablename__ = "ai_hint"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    session_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("interview_session.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
    )

    kind: HintKind = Field(
        default=HintKind.FOLLOW_UP_QUESTION,
        sa_column=Column(SQLEnum(HintKind), nullable=False),
    )
    content: str = Field(default="")
    score_delta: float | None = Field(default=None)

    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
