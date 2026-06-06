"""WS /api/live-feed/{session_id} - outbound to the Next.js dashboard.

This is the read side of the dispatcher (P6 -> P8 in the DFD). The frontend
subscribes here and receives transcript + hint events as JSON envelopes.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session, select

from app.db import engine
from app.models.hint import AIHint
from app.models.session import InterviewSession
from app.models.transcript import TranscriptSegment
from app.services.dispatcher import dispatcher

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/live-feed", tags=["live-feed"])


@router.websocket("/{session_id}")
async def live_feed(websocket: WebSocket, session_id: uuid.UUID) -> None:
    await websocket.accept()
    queue = await dispatcher.subscribe(session_id)
    log.info("live_feed_connected", session_id=str(session_id))
    try:
        for event in _history_events(session_id):
            await websocket.send_json(event)

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15.0)
                await websocket.send_json(event)
            except asyncio.TimeoutError:
                # heartbeat to keep proxies / browsers from idling out the socket
                await websocket.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        log.info("live_feed_disconnected", session_id=str(session_id))
    finally:
        await dispatcher.unsubscribe(session_id, queue)


def _history_events(session_id: uuid.UUID) -> list[dict[str, Any]]:
    with Session(engine) as db:
        session = db.get(InterviewSession, session_id)
        if session is None:
            return [{"type": "error", "message": "session not found"}]

        transcripts = db.exec(
            select(TranscriptSegment)
            .where(TranscriptSegment.session_id == session_id)
            .order_by(TranscriptSegment.created_at)
        ).all()
        hints = db.exec(
            select(AIHint)
            .where(AIHint.session_id == session_id)
            .order_by(AIHint.created_at.desc())
        ).all()

        events: list[dict[str, Any]] = [
            {
                "type": "session.status",
                "session_id": str(session.id),
                "status": session.status.value,
            }
        ]
        events.extend(
            {
                "type": "transcript.final" if segment.is_final else "transcript.partial",
                "segment": _serialize_segment(segment),
            }
            for segment in transcripts
        )
        events.extend({"type": "hint", "hint": _serialize_hint(hint)} for hint in hints)
        return events


def _serialize_segment(segment: TranscriptSegment) -> dict[str, Any]:
    return {
        "id": str(segment.id),
        "session_id": str(segment.session_id),
        "speaker": segment.speaker.value,
        "text": segment.text,
        "start_ms": segment.start_ms,
        "end_ms": segment.end_ms,
        "is_final": segment.is_final,
        "created_at": segment.created_at.isoformat(),
    }


def _serialize_hint(hint: AIHint) -> dict[str, Any]:
    return {
        "id": str(hint.id),
        "session_id": str(hint.session_id),
        "kind": hint.kind.value,
        "content": hint.content,
        "score_delta": hint.score_delta,
        "created_at": hint.created_at.isoformat(),
    }
