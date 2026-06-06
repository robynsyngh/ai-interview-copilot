"""Wire formats consumed by the REST endpoints + WebSocket dispatcher.

Mirrors `packages/shared/src/messages.ts`. Keep both ends in sync.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field


# ---------- REST: /api/session ----------------------------------------------


AssistModeLiteral = Literal["interviewer", "interviewee"]


class CreateSessionRequest(BaseModel):
    candidate_name: str | None = Field(default=None, max_length=200)
    job_description: str = Field(..., min_length=1)
    resume_text: str = Field(..., min_length=1)
    mode: AssistModeLiteral = "interviewer"


class CreateSessionResponse(BaseModel):
    session_id: uuid.UUID
    live_stream_url: str
    live_feed_url: str


class SessionInfoResponse(BaseModel):
    session_id: uuid.UUID
    candidate_name: str | None
    status: str
    mode: AssistModeLiteral


class UpdateModeRequest(BaseModel):
    mode: AssistModeLiteral


class AskQuestionRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)


class DocumentExtractResponse(BaseModel):
    """Result of parsing an uploaded resume / JD file into plain text."""

    text: str
    kind: Literal["pdf", "docx", "text"]
    filename: str | None = None
    chars: int


class FinalizeSessionRequest(BaseModel):
    session_id: uuid.UUID


# ---------- WebSocket: /api/live-stream  (extension -> API control frames) --


class WsSessionStart(BaseModel):
    type: Literal["session.start"] = "session.start"
    session_id: uuid.UUID
    sample_rate: int = Field(default=16000, ge=8000, le=48000)


class WsSessionStop(BaseModel):
    type: Literal["session.stop"] = "session.stop"
    session_id: uuid.UUID


class WsSessionHeartbeat(BaseModel):
    type: Literal["session.heartbeat"] = "session.heartbeat"
    session_id: uuid.UUID
    ts: int


ExtensionToApiMessage = Annotated[
    WsSessionStart | WsSessionStop | WsSessionHeartbeat,
    Field(discriminator="type"),
]


# ---------- WebSocket: /api/live-feed  (API -> Next.js outbound events) -----


class TranscriptPayload(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    speaker: str
    text: str
    start_ms: int
    end_ms: int
    is_final: bool
    created_at: datetime


class HintPayload(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    kind: str
    content: str
    score_delta: float | None
    created_at: datetime


class LiveFeedTranscriptPartial(BaseModel):
    type: Literal["transcript.partial"] = "transcript.partial"
    segment: TranscriptPayload


class LiveFeedTranscriptFinal(BaseModel):
    type: Literal["transcript.final"] = "transcript.final"
    segment: TranscriptPayload


class LiveFeedHint(BaseModel):
    type: Literal["hint"] = "hint"
    hint: HintPayload


class LiveFeedSessionStatus(BaseModel):
    type: Literal["session.status"] = "session.status"
    session_id: uuid.UUID
    status: str


class LiveFeedError(BaseModel):
    type: Literal["error"] = "error"
    message: str
    code: str | None = None


LiveFeedEvent = Annotated[
    LiveFeedTranscriptPartial
    | LiveFeedTranscriptFinal
    | LiveFeedHint
    | LiveFeedSessionStatus
    | LiveFeedError,
    Field(discriminator="type"),
]
