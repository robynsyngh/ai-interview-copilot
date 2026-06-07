"""POST /api/session - register a new InterviewSession in D1."""

from __future__ import annotations

import re
import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.models.hint import AIHint, HintKind
from app.models.session import InterviewSession, SessionStatus
from app.models.transcript import Speaker, TranscriptSegment
from app.schemas.messages import (
    AskQuestionRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    SessionInfoResponse,
    UpdateModeRequest,
)
from app.services.dispatcher import dispatcher
from app.services.github_models import GitHubModelsEvaluator

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/session", tags=["session"])


@router.post("", response_model=CreateSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: CreateSessionRequest,
    db: Session = Depends(get_session),
) -> CreateSessionResponse:
    record = InterviewSession(
        candidate_name=payload.candidate_name,
        job_description=payload.job_description,
        resume_text=payload.resume_text,
        mode=payload.mode,
        status=SessionStatus.PENDING,
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    # Deep, sectioned LLM question bank FIRST (Node.js → stack → JS fundamentals →
    # DSA). Inserting it before the starter questions keeps that section order
    # leading in the dashboard, which groups by first-seen section. Best-effort:
    # never let this block or fail session creation.
    for question in await _generate_practice_questions(
        payload.resume_text, payload.job_description
    ):
        db.add(
            AIHint(
                session_id=record.id,
                kind=HintKind.FOLLOW_UP_QUESTION,
                content=question,
                score_delta=None,
            )
        )

    # Resume/behavioral starter questions afterwards (their own sections, plus a
    # few that merge into the detected-technology blocks above).
    for question in _resume_starter_questions(payload.resume_text, payload.job_description):
        db.add(
            AIHint(
                session_id=record.id,
                kind=HintKind.FOLLOW_UP_QUESTION,
                content=question,
                score_delta=None,
            )
        )
    db.commit()

    return CreateSessionResponse(
        session_id=record.id,
        live_stream_url=f"/api/live-stream/{record.id}",
        live_feed_url=f"/api/live-feed/{record.id}",
    )


@router.get("/{session_id}", response_model=SessionInfoResponse)
async def get_session_info(
    session_id: uuid.UUID,
    db: Session = Depends(get_session),
) -> SessionInfoResponse:
    record = db.get(InterviewSession, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session not found")
    return SessionInfoResponse(
        session_id=record.id,
        candidate_name=record.candidate_name,
        status=record.status.value,
        mode=record.mode if record.mode in ("interviewer", "interviewee") else "interviewer",
    )


@router.patch("/{session_id}/mode", response_model=SessionInfoResponse)
async def update_session_mode(
    session_id: uuid.UUID,
    payload: UpdateModeRequest,
    db: Session = Depends(get_session),
) -> SessionInfoResponse:
    record = db.get(InterviewSession, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session not found")
    record.mode = payload.mode
    db.add(record)
    db.commit()
    db.refresh(record)
    return SessionInfoResponse(
        session_id=record.id,
        candidate_name=record.candidate_name,
        status=record.status.value,
        mode=record.mode,
    )


@router.post("/{session_id}/ask")
async def ask_question(
    session_id: uuid.UUID,
    payload: AskQuestionRequest,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """Manually paste a question and get an answer (interviewee) or rubric (interviewer).

    The generated hint is persisted and broadcast over the live feed, so any open
    dashboard for this session renders it alongside the auto-detected answers.
    """
    record = db.get(InterviewSession, session_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session not found")

    mode = record.mode if record.mode in ("interviewer", "interviewee") else "interviewer"
    question_text = payload.question.strip()
    if not question_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="question is required"
        )

    question_segment = TranscriptSegment(
        session_id=session_id,
        speaker=Speaker.INTERVIEWER,
        text=question_text,
        is_final=True,
    )
    db.add(question_segment)
    db.commit()
    db.refresh(question_segment)
    await dispatcher.broadcast(
        session_id,
        {"type": "transcript.final", "segment": _serialize_segment(question_segment)},
    )

    recent_segments = db.exec(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == session_id)
        .order_by(TranscriptSegment.created_at.desc())
        .limit(12)
    ).all()
    recent_transcript = "\n".join(
        f"{segment.speaker.value}: {segment.text}"
        for segment in reversed(recent_segments)
        if segment.text.strip()
    )

    evaluator = GitHubModelsEvaluator()
    try:
        if mode == "interviewee":
            proposal = await evaluator.answer_as_candidate(
                session_id=session_id,
                question=question_text,
                recent_transcript=recent_transcript,
                job_description=record.job_description,
                resume_text=record.resume_text,
            )
        else:
            proposal = await evaluator.answer_rubric(
                session_id=session_id,
                question=question_text,
                recent_transcript=recent_transcript,
                job_description=record.job_description,
                resume_text=record.resume_text,
            )
    finally:
        await evaluator.aclose()

    if proposal is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not generate an answer. Check that the model token is configured.",
        )

    hint = AIHint(
        session_id=session_id,
        kind=proposal.kind,
        content=proposal.content,
        score_delta=proposal.score_delta,
    )
    db.add(hint)
    db.commit()
    db.refresh(hint)

    hint_payload = _serialize_hint(hint)
    await dispatcher.broadcast(session_id, {"type": "hint", "hint": hint_payload})
    return {"hint": hint_payload, "segment": _serialize_segment(question_segment)}


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


async def _generate_practice_questions(resume_text: str, job_description: str) -> list[str]:
    experience_level = _estimate_experience_level(resume_text)
    sections = _question_bank_sections(resume_text, job_description)
    evaluator = GitHubModelsEvaluator()
    try:
        return await evaluator.generate_question_bank(
            sections=sections,
            job_description=job_description,
            resume_text=resume_text,
            experience_level=experience_level,
            per_section=10,
        )
    except Exception as exc:  # noqa: BLE001 - never block session creation
        log.warning("practice_question_generation_failed", error=str(exc))
        return []
    finally:
        await evaluator.aclose()


# Topics that aren't a single library but must always be grilled for a JS/TS
# stack. Appended after the concrete technologies so Node.js etc. come first.
_JS_STACK_SKILLS = {
    "Node.js",
    "JavaScript",
    "TypeScript",
    "React",
    "Next.js",
    "Angular",
    "Express",
    "NestJS",
}


def _question_bank_sections(resume_text: str, job_description: str) -> list[str]:
    """Ordered list of topics to generate a 10-question block for.

    Node.js (or the primary JS runtime) leads, followed by the rest of the
    detected stack, then always a dedicated "JavaScript Fundamentals" block (when
    the stack is JS/TS based) and a "Data Structures & Algorithms" block.
    """
    skills = _extract_skills(f"{resume_text}\n{job_description}")

    # "JavaScript" as a bare skill is covered by the dedicated fundamentals block
    # below; drop it from the per-technology list to avoid a redundant section.
    tech = [s for s in skills if s != "JavaScript"]

    # Surface Node.js (then other runtimes) first, as requested.
    lead = ["Node.js", "TypeScript"]
    ordered = [s for s in lead if s in tech] + [s for s in tech if s not in lead]
    # Cap the technology fan-out so we don't issue an unbounded number of calls.
    ordered = ordered[:8]

    sections = list(ordered)
    if any(s in _JS_STACK_SKILLS for s in skills):
        sections.append("JavaScript Fundamentals")
    sections.append("Data Structures & Algorithms")
    return sections


def _estimate_experience_level(resume_text: str) -> str:
    text = resume_text.lower()
    years = [int(match) for match in re.findall(r"(\d{1,2})\s*\+?\s*years?", text)]
    max_years = max(years) if years else 0

    if (
        re.search(r"\b(senior|lead|principal|staff|architect|head of|manager)\b", text)
        or max_years >= 6
    ):
        return "senior"
    if re.search(r"\b(intern|fresher|trainee|graduate|entry[- ]level)\b", text) or (
        0 < max_years <= 1
    ):
        return "junior"
    if max_years >= 3:
        return "mid"
    return "mid" if max_years else "junior"


def _serialize_hint(hint: AIHint) -> dict[str, Any]:
    return {
        "id": str(hint.id),
        "session_id": str(hint.session_id),
        "kind": hint.kind.value,
        "content": hint.content,
        "score_delta": hint.score_delta,
        "created_at": hint.created_at.isoformat(),
    }


def _resume_starter_questions(resume_text: str, job_description: str) -> list[str]:
    resume = " ".join(resume_text.split())
    jd = " ".join(job_description.split())
    skills = _extract_skills(f"{resume_text}\n{job_description}")
    questions = _skill_question_bank(skills)

    questions.append(
        "[Easy] [Resume] Ask: Walk me through the most relevant project or experience on your resume for this role. What was your specific contribution?"
    )

    companies = _extract_named_phrases(resume_text)
    for company in companies[:2]:
        company_name = company.rstrip(".")
        questions.append(
            f"[Medium] [Experience] Ask: You mention {company_name}. What problem did you work on there, and what measurable result did you deliver?"
        )

    if re.search(
        r"\bcollege|university|degree|bachelor|master|b\.?tech|m\.?tech\b", resume, re.IGNORECASE
    ):
        questions.append(
            "[Easy] [Education] Ask: Which course, lab, or academic project best prepared you for this role, and why?"
        )

    if re.search(r"\baward|winner|rank|score|cgpa|gpa|achievement\b", resume, re.IGNORECASE):
        questions.append(
            "[Medium] [Achievement] Ask: Which achievement on your resume are you most proud of, and what did you personally do to earn it?"
        )

    if re.search(
        r"\bproject|built|developed|implemented|system|application\b", resume, re.IGNORECASE
    ):
        questions.append(
            "[Hard] [Project depth] Ask: Pick one technical project from your resume and explain the architecture, trade-offs, and what you would improve now."
        )

    if jd:
        questions.append(
            "[Medium] [Role fit] Ask: Which requirement in this job description is your strongest match, and what evidence from your resume proves it?"
        )

    return _dedupe(questions)[:18]


def _skill_question_bank(skills: list[str]) -> list[str]:
    questions: list[str] = []
    for skill in skills[:5]:
        questions.extend(
            [
                f"[Easy] [{skill}] Ask: Where have you used {skill}, and what did you build with it?",
                f"[Medium] [{skill}] Ask: Describe a tricky problem you solved using {skill}. What trade-off did you make?",
                f"[Hard] [{skill}] Ask: If your {skill} solution had to scale or handle failure in production, what would you change and why?",
            ]
        )
    if not questions:
        questions.extend(
            [
                "[Easy] [Resume] Ask: What part of your resume is most relevant to this role?",
                "[Medium] [Problem solving] Ask: Tell me about a difficult technical problem you solved and how you approached it.",
                "[Hard] [Ownership] Ask: Describe a project where you made an architectural decision. What alternatives did you reject?",
            ]
        )
    return questions


def _extract_skills(text: str) -> list[str]:
    known_skills = [
        "Angular",
        "React",
        "Next.js",
        "Node.js",
        "Express",
        "TypeScript",
        "JavaScript",
        "Python",
        "FastAPI",
        "Django",
        "PostgreSQL",
        "SQL",
        "MongoDB",
        "Redis",
        "Kafka",
        "RabbitMQ",
        "Elasticsearch",
        "AWS",
        "Docker",
        "Kubernetes",
        "REST APIs",
        "GraphQL",
        "WebSocket",
        "NestJS",
        "Redux",
        "RxJS",
        "Stripe",
        "Payment Gateway",
        "Microservices",
        "System Design",
        "Enterprise Web Applications",
    ]
    # Some skills are written many ways ("NodeJS", "Node JS", "Node.js"). Match on
    # a set of aliases so detection isn't defeated by punctuation/spacing.
    aliases: dict[str, list[str]] = {
        "Node.js": ["node.js", "nodejs", "node js", "node"],
        "Next.js": ["next.js", "nextjs", "next js"],
        "React": ["react.js", "reactjs", "react"],
        "Express": ["express.js", "expressjs", "express"],
        "NestJS": ["nest.js", "nestjs", "nest js"],
        "RxJS": ["rxjs", "rx.js"],
        "REST APIs": ["rest api", "rest apis", "restful"],
        "PostgreSQL": ["postgresql", "postgres", "psql"],
        "Elasticsearch": ["elasticsearch", "elastic search"],
    }
    normalized = f" {' '.join(text.lower().split())} "
    found = []
    for skill in known_skills:
        tokens = aliases.get(skill, [skill.lower()])
        # Word-boundary check avoids "sql" matching inside "postgresql" twice, etc.
        if any(
            re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", normalized)
            for token in tokens
        ):
            found.append(skill)
    return _dedupe(found)


def _extract_named_phrases(text: str) -> list[str]:
    phrases: list[str] = []
    for line in text.splitlines():
        line = line.strip(" -•\t")
        if not line:
            continue
        if not re.search(
            r"\b(company|pvt|ltd|llc|inc|corp|technologies|systems|solutions)\b",
            line,
            re.IGNORECASE,
        ):
            continue
        cleaned = re.sub(r"\b(?:19|20)\d{2}\b", "", line)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" -–—,")
        if cleaned and not re.search(r"\bcollege|university\b", cleaned, re.IGNORECASE):
            phrases.append(cleaned)
    return _dedupe(phrases)


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
