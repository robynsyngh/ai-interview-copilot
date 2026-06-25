"""FinalReport - aggregated post-interview evaluation."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Column, DateTime, Field, ForeignKey, SQLModel
from sqlmodel import Enum as SQLEnum


class Recommendation(StrEnum):
    STRONG_HIRE = "strong_hire"
    HIRE = "hire"
    NO_HIRE = "no_hire"
    STRONG_NO_HIRE = "strong_no_hire"


class FinalReport(SQLModel, table=True):
    __tablename__ = "final_report"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    session_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("interview_session.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
            unique=True,
        ),
    )

    overall_score: float = Field(default=0.0)
    technical_score: float = Field(default=0.0)
    communication_score: float = Field(default=0.0)
    culture_fit_score: float = Field(default=0.0)

    summary: str = Field(default="")
    technical_analysis: str = Field(default="")
    communication_analysis: str = Field(default="")
    culture_analysis: str = Field(default="")
    strengths: list[str] = Field(default_factory=list, sa_column=Column(JSONB, nullable=False))
    weaknesses: list[str] = Field(default_factory=list, sa_column=Column(JSONB, nullable=False))

    recommendation: Recommendation = Field(
        default=Recommendation.NO_HIRE,
        sa_column=Column(SQLEnum(Recommendation), nullable=False),
    )
    recommendation_rationale: str = Field(default="")

    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
