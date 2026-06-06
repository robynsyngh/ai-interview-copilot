"""WS /api/live-stream/{session_id} - inbound from the Chrome extension.

Pipeline (matches DFD):
    Extension ──(binary audio)──► P3 (this router)
                                  ├─► P4 DeepgramStream         ──► transcripts
                                  ├─► P5 GitHubModelsEvaluator  ──► hints
                                  └─► persist + P6 dispatcher fan-out
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections import deque
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from app.db import engine
from app.models.hint import AIHint
from app.models.session import InterviewSession, SessionStatus
from app.models.transcript import Speaker, TranscriptSegment
from app.services.deepgram import DeepgramStream, TranscriptEvent
from app.services.dispatcher import dispatcher
from app.services.github_models import GitHubModelsEvaluator, HintProposal

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/live-stream", tags=["live-stream"])
MIN_HINT_INTERVAL_SECONDS = 20.0
# A spoken question reaches us as several Deepgram finals. We wait this long
# after the last interviewer final before treating the utterance as a complete
# question, so we answer the whole question instead of a half-thought fragment.
QUESTION_DEBOUNCE_SECONDS = 1.2


@router.websocket("/{session_id}")
async def live_stream(websocket: WebSocket, session_id: uuid.UUID) -> None:
    await websocket.accept()
    log.info("live_stream_connected", session_id=str(session_id))

    context = _load_session_context(session_id)
    if context is None:
        await websocket.send_json({"type": "error", "message": "session not found"})
        await websocket.close()
        return

    job_description, resume_text, initial_mode = context
    _set_session_status(session_id, SessionStatus.ACTIVE)
    await dispatcher.broadcast(
        session_id,
        {"type": "session.status", "session_id": str(session_id), "status": "active"},
    )

    # Deepgram is started lazily: the extension's first control frame reports the
    # real capture sample rate and channel count. Starting before we know these
    # used to risk a hard-coded rate that didn't match the audio (garbled text).
    keywords = _deepgram_keywords(f"{job_description}\n{resume_text}")
    stream_state: dict[str, Any] = {"deepgram": None, "forward_task": None}

    evaluator = GitHubModelsEvaluator()

    transcript_buffer: deque[str] = deque(maxlen=40)
    recent_hint_texts: deque[str] = deque(maxlen=8)
    eval_state: dict[str, Any] = {
        "in_flight": False,
        "pending": False,
        "last_eval_at": 0.0,
        "last_eval_window": "",
    }
    # Turn-based question tracking for interviewee answers / interviewer rubrics.
    # `parts` accumulates the interviewer's finals for the current utterance;
    # `seq` is a monotonic id per answered question so a newer question can
    # cancel/supersede an answer still being generated for an earlier one.
    question_state: dict[str, Any] = {
        "seq": 0,
        "parts": [],
        "last_norm": "",
        "debounce_task": None,
        "answer_task": None,
    }

    async def maybe_evaluate() -> None:
        if eval_state["in_flight"]:
            eval_state["pending"] = True
            return
        eval_state["in_flight"] = True
        try:
            while True:
                window = "\n".join(transcript_buffer)
                now = time.monotonic()
                if (
                    window == eval_state["last_eval_window"]
                    or now - eval_state["last_eval_at"] < MIN_HINT_INTERVAL_SECONDS
                ):
                    break
                eval_state["last_eval_at"] = now
                eval_state["last_eval_window"] = window

                proposal = await evaluator.propose_hint(
                    session_id=session_id,
                    recent_transcript=window,
                    job_description=job_description,
                    resume_text=resume_text,
                    mode=_get_session_mode(session_id),
                )
                if proposal is not None:
                    if _is_duplicate_hint(proposal.content, recent_hint_texts):
                        log.info(
                            "github_models_hint_skipped_duplicate",
                            session_id=str(session_id),
                        )
                        break
                    hint = _persist_hint(proposal)
                    if hint is not None:
                        recent_hint_texts.append(proposal.content)
                        await dispatcher.broadcast(
                            session_id,
                            {
                                "type": "hint",
                                "hint": _serialize_hint(hint),
                            },
                        )
                if not eval_state["pending"]:
                    break
                eval_state["pending"] = False
        finally:
            eval_state["in_flight"] = False

    def consider_question_part(text: str) -> None:
        """Accumulate one interviewer final and (re)arm the debounce flush.

        Each new final pushes the flush out by QUESTION_DEBOUNCE_SECONDS, so we
        only answer once the interviewer stops talking — i.e. the whole question
        has arrived, not a single fragment like "explain me in detail how".
        """
        question_state["parts"].append(text)
        existing = question_state["debounce_task"]
        if existing is not None and not existing.done():
            existing.cancel()
        question_state["debounce_task"] = asyncio.create_task(flush_question_after_debounce())

    async def flush_question_after_debounce() -> None:
        try:
            await asyncio.sleep(QUESTION_DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return
        await flush_question()

    async def flush_question() -> None:
        parts = question_state["parts"]
        question_state["parts"] = []
        question_state["debounce_task"] = None
        question = " ".join(p.strip() for p in parts if p.strip()).strip()
        if not _looks_like_interview_question(question):
            return
        normalized = _normalize_hint(question)
        if not normalized or normalized == question_state["last_norm"]:
            return
        question_state["last_norm"] = normalized

        # New turn: supersede any answer still being generated for a prior question.
        question_state["seq"] += 1
        seq = question_state["seq"]
        prior = question_state["answer_task"]
        if prior is not None and not prior.done():
            prior.cancel()
        question_state["answer_task"] = asyncio.create_task(generate_answer(question, seq))

    async def generate_answer(question: str, seq: int) -> None:
        mode = _get_session_mode(session_id)
        context = "\n".join(transcript_buffer)
        if mode == "interviewee":
            # The candidate wants the actual answer to say, not an evaluation rubric.
            proposal = await evaluator.answer_as_candidate(
                session_id=session_id,
                question=question,
                recent_transcript=context,
                job_description=job_description,
                resume_text=resume_text,
            )
        else:
            proposal = await evaluator.answer_rubric(
                session_id=session_id,
                question=question,
                recent_transcript=context,
                job_description=job_description,
                resume_text=resume_text,
            )
        if proposal is None:
            return
        # A newer question arrived while we were generating this one's answer:
        # drop the stale result so the panel never shows a previous question's answer.
        if seq != question_state["seq"]:
            log.info(
                "answer_superseded",
                session_id=str(session_id),
                seq=seq,
                current=question_state["seq"],
            )
            return
        hint = _persist_hint(proposal)
        if hint is not None:
            await dispatcher.broadcast(
                session_id,
                {"type": "hint", "hint": _serialize_hint(hint)},
            )

    async def ensure_deepgram_started(sample_rate: int, channels: int) -> None:
        if stream_state["deepgram"] is not None:
            return
        # Local mic is channel 0, remote tab audio is channel 1. Who that maps to
        # depends on who is running the tool: in interviewer mode the local mic is
        # the interviewer; in interviewee mode the local mic is the candidate.
        if initial_mode == "interviewee":
            channel_speakers = {0: Speaker.CANDIDATE, 1: Speaker.INTERVIEWER}
        else:
            channel_speakers = {0: Speaker.INTERVIEWER, 1: Speaker.CANDIDATE}
        deepgram = DeepgramStream(
            session_id=session_id,
            sample_rate=sample_rate,
            channels=channels,
            keywords=keywords,
            channel_speakers=channel_speakers,
        )
        await deepgram.start()
        stream_state["deepgram"] = deepgram
        stream_state["forward_task"] = asyncio.create_task(forward_transcripts(deepgram))
        log.info(
            "deepgram_session_started",
            session_id=str(session_id),
            sample_rate=sample_rate,
            channels=channels,
        )

    async def forward_transcripts(deepgram: DeepgramStream) -> None:
        async for event in deepgram.events():
            if event.is_final:
                segment = _persist_transcript(event)
                if segment is None:
                    continue
                payload: dict[str, Any] = {
                    "type": "transcript.final",
                    "segment": _serialize_segment(segment),
                }
            else:
                payload = {
                    "type": "transcript.partial",
                    "segment": _serialize_partial(event),
                }
            await dispatcher.broadcast(session_id, payload)

            if event.is_final and event.text.strip():
                label = f"{event.speaker.value}: " if event.speaker != Speaker.UNKNOWN else ""
                transcript_buffer.append(f"{label}{event.text.strip()}")
                # Only the interviewer asks questions. Single-channel audio can't
                # be attributed (UNKNOWN), so we still consider it to keep mono
                # capture working; the candidate's own speech never triggers answers.
                if event.speaker in (Speaker.INTERVIEWER, Speaker.UNKNOWN):
                    consider_question_part(event.text.strip())
                asyncio.create_task(maybe_evaluate())

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                # If the extension never sent a control frame (older build),
                # fall back to mono @ 16 kHz so audio still flows.
                if stream_state["deepgram"] is None:
                    await ensure_deepgram_started(sample_rate=16000, channels=1)
                await stream_state["deepgram"].send_audio(message["bytes"])
            elif message.get("text") is not None:
                params = _parse_control_frame(message["text"], session_id)
                if params is not None:
                    await ensure_deepgram_started(
                        sample_rate=params["sample_rate"],
                        channels=params["channels"],
                    )
            else:
                # disconnect frame
                if message.get("type") == "websocket.disconnect":
                    break
    except WebSocketDisconnect:
        log.info("live_stream_disconnected", session_id=str(session_id))
    except Exception as exc:  # noqa: BLE001 - boundary; report and close
        log.exception("live_stream_error", session_id=str(session_id), error=str(exc))
    finally:
        for key in ("debounce_task", "answer_task"):
            task = question_state.get(key)
            if task is not None and not task.done():
                task.cancel()
        forward_task = stream_state["forward_task"]
        if forward_task is not None:
            forward_task.cancel()
            try:
                await forward_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        deepgram = stream_state["deepgram"]
        if deepgram is not None:
            await deepgram.aclose()
        await evaluator.aclose()
        _set_session_status(session_id, SessionStatus.COMPLETED)
        await dispatcher.broadcast(
            session_id,
            {"type": "session.status", "session_id": str(session_id), "status": "completed"},
        )


def _load_session_context(session_id: uuid.UUID) -> tuple[str, str, str] | None:
    with Session(engine) as db:
        record = db.get(InterviewSession, session_id)
        if record is None:
            return None
        mode = record.mode if record.mode in ("interviewer", "interviewee") else "interviewer"
        return (record.job_description or "", record.resume_text or "", mode)


def _get_session_mode(session_id: uuid.UUID) -> str:
    """Read the mode fresh so a live toggle on the dashboard takes effect."""
    with Session(engine) as db:
        record = db.get(InterviewSession, session_id)
        if record is None:
            return "interviewer"
        return record.mode if record.mode in ("interviewer", "interviewee") else "interviewer"


def _persist_transcript(event: TranscriptEvent) -> TranscriptSegment | None:
    with Session(engine) as db:
        segment = TranscriptSegment(
            session_id=event.session_id,
            speaker=event.speaker,
            text=event.text,
            start_ms=event.start_ms,
            end_ms=event.end_ms,
            is_final=event.is_final,
        )
        db.add(segment)
        db.commit()
        db.refresh(segment)
        return segment


def _persist_hint(proposal: HintProposal) -> AIHint | None:
    with Session(engine) as db:
        hint = AIHint(
            session_id=proposal.session_id,
            kind=proposal.kind,
            content=proposal.content,
            score_delta=proposal.score_delta,
        )
        db.add(hint)
        db.commit()
        db.refresh(hint)
        return hint


def _set_session_status(session_id: uuid.UUID, status: SessionStatus) -> None:
    with Session(engine) as db:
        record = db.get(InterviewSession, session_id)
        if record is None:
            return
        record.status = status
        db.add(record)
        db.commit()


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


def _serialize_partial(event: TranscriptEvent) -> dict[str, Any]:
    return {
        "id": f"partial-{event.session_id}",
        "session_id": str(event.session_id),
        "speaker": event.speaker.value,
        "text": event.text,
        "start_ms": event.start_ms,
        "end_ms": event.end_ms,
        "is_final": False,
        "created_at": event.ts.isoformat(),
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


def _parse_control_frame(raw: str, session_id: uuid.UUID) -> dict[str, int] | None:
    """Parse a JSON control frame from the extension.

    Returns the capture parameters for a `session.start` frame, otherwise None.
    """
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("live_stream_bad_control_json", session_id=str(session_id))
        return None
    log.debug("live_stream_control", session_id=str(session_id), message=message)

    if message.get("type") != "session.start":
        return None

    try:
        sample_rate = int(message.get("sample_rate") or 16000)
    except (TypeError, ValueError):
        sample_rate = 16000
    try:
        channels = int(message.get("channels") or 1)
    except (TypeError, ValueError):
        channels = 1

    sample_rate = sample_rate if 8000 <= sample_rate <= 96000 else 16000
    channels = channels if channels in (1, 2) else 1
    return {"sample_rate": sample_rate, "channels": channels}


def _is_duplicate_hint(content: str, recent: deque[str]) -> bool:
    normalized = _normalize_hint(content)
    if not normalized:
        return True
    for prior in recent:
        prior_normalized = _normalize_hint(prior)
        if normalized == prior_normalized:
            return True
        words = set(normalized.split())
        prior_words = set(prior_normalized.split())
        if words and len(words & prior_words) / len(words) >= 0.75:
            return True
    return False


def _normalize_hint(content: str) -> str:
    return " ".join(
        word.strip(".,:;!?()[]{}\"'").lower()
        for word in content.split()
        if len(word.strip(".,:;!?()[]{}\"'")) > 3
    )


def _deepgram_keywords(text: str) -> list[str]:
    """Boost resume/JD terms that ASR often mishears as common words."""
    stopwords = {
        "candidate",
        "resume",
        "experience",
        "project",
        "projects",
        "skills",
        "education",
        "achievement",
        "achievements",
        "technology",
        "technologies",
    }
    terms: list[str] = []

    # Proper nouns, company names, and product names often need help.
    for match in re.findall(r"\b[A-Z][A-Za-z0-9&.+#-]{2,}(?:\s+[A-Z][A-Za-z0-9&.+#-]{2,}){0,3}\b", text):
        terms.append(match.strip())

    # Common technical/domain terms from this project and interview use case.
    for skill in [
        "Angular",
        "Node.js",
        "React",
        "TypeScript",
        "JavaScript",
        "Python",
        "FastAPI",
        "PostgreSQL",
        "AWS",
        "Stripe",
        "payment gateway",
        "enterprise web applications",
        "microservices",
        "REST APIs",
        "GitHub",
        "Deepgram",
    ]:
        if skill.lower() in text.lower():
            terms.append(skill)

    cleaned: list[str] = []
    for term in terms:
        normalized = " ".join(term.split()).strip(".,:;!?()[]{}\"'")
        if len(normalized) < 3 or normalized.lower() in stopwords:
            continue
        # Deepgram v3 keyword boosting accepts "term:boost" strings.
        cleaned.append(f"{normalized}:8")

    return _dedupe(cleaned)[:40]


def _looks_like_interview_question(text: str) -> bool:
    normalized = text.strip().lower()
    if len(normalized.split()) < 4:
        return False
    if normalized.endswith("?"):
        return True
    return bool(
        re.match(
            r"^(can you|could you|would you|how do|how would|what is|what are|what was|why did|why would|tell me|explain|describe|walk me through|have you|do you)",
            normalized,
        )
    )


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result
