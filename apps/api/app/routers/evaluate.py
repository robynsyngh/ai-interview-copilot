"""POST /api/evaluate - finalize a session and produce a FinalReport."""

from __future__ import annotations

from datetime import datetime
from statistics import mean

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.db import get_session
from app.models.hint import AIHint, HintKind
from app.models.report import FinalReport, Recommendation
from app.models.session import InterviewSession, SessionStatus
from app.models.transcript import Speaker, TranscriptSegment
from app.schemas.messages import FinalizeSessionRequest
from app.services.github_models import FinalReportProposal, GitHubModelsEvaluator

router = APIRouter(prefix="/api/evaluate", tags=["evaluate"])

# Below this many substantive candidate words we refuse to produce a positive
# evaluation - there simply isn't enough evidence to judge the candidate.
MIN_CANDIDATE_WORDS = 20

# Only these hint kinds are genuine observations about the candidate. Rubrics,
# expected answers, and the question bank are stored as clarifying_prompt /
# follow_up_question and must NOT be fed to the report (the model would
# otherwise treat the expected answer as something the candidate actually said).
_EVIDENCE_HINT_KINDS = {
    HintKind.RED_FLAG,
    HintKind.STRENGTH_SIGNAL,
    HintKind.SCORE_UPDATE,
}


@router.post("", status_code=status.HTTP_201_CREATED)
async def evaluate(
    payload: FinalizeSessionRequest,
    db: Session = Depends(get_session),
) -> dict[str, str]:
    session = db.get(InterviewSession, payload.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    existing = db.exec(
        select(FinalReport).where(FinalReport.session_id == payload.session_id)
    ).first()
    if existing is not None and not _looks_like_placeholder(existing):
        return {"report_id": str(existing.id), "status": "already_exists"}

    transcripts = db.exec(
        select(TranscriptSegment)
        .where(TranscriptSegment.session_id == payload.session_id)
        .order_by(TranscriptSegment.created_at)
    ).all()
    hints = db.exec(
        select(AIHint)
        .where(AIHint.session_id == payload.session_id)
        .order_by(AIHint.created_at)
    ).all()

    candidate_segments = _candidate_segments(transcripts)
    candidate_words = sum(len(segment.text.split()) for segment in candidate_segments)

    # Hard evidence gate: if the candidate barely spoke, do NOT let the model
    # invent a positive evaluation from the resume/JD. Produce an honest
    # "insufficient evidence" report instead.
    if candidate_words < MIN_CANDIDATE_WORDS:
        proposal = _insufficient_evidence_report(candidate_words)
        report = existing or FinalReport(session_id=payload.session_id)
        _apply_report(report, proposal)
        db.add(report)
        session.status = SessionStatus.COMPLETED
        session.completed_at = datetime.utcnow()
        db.add(session)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing_after_race = db.exec(
                select(FinalReport).where(FinalReport.session_id == payload.session_id)
            ).first()
            if existing_after_race is None:
                raise
            return {"report_id": str(existing_after_race.id), "status": "already_exists"}
        db.refresh(report)
        return {"report_id": str(report.id), "status": "updated" if existing else "created"}

    # The candidate's own words are the evidence. Interviewer turns are kept only
    # as light context. Rubric/answer/question-bank hints are excluded entirely.
    transcript_text = "\n".join(
        f"{segment.speaker.value}: {segment.text}"
        for segment in transcripts
        if segment.text.strip()
    )
    hint_text = "\n".join(
        f"{hint.kind.value}: {hint.content}"
        for hint in hints
        if hint.content.strip() and hint.kind in _EVIDENCE_HINT_KINDS
    )

    evaluator = GitHubModelsEvaluator()
    try:
        proposal = await evaluator.final_report(
            session_id=payload.session_id,
            transcript=transcript_text,
            hints=hint_text,
            job_description=session.job_description,
            resume_text=session.resume_text,
        )
    finally:
        await evaluator.aclose()

    if proposal is None:
        proposal = _fallback_report(candidate_segments, hints, session.job_description)

    report = existing or FinalReport(session_id=payload.session_id)
    _apply_report(report, proposal)
    db.add(report)

    session.status = SessionStatus.COMPLETED
    session.completed_at = datetime.utcnow()
    db.add(session)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing_after_race = db.exec(
            select(FinalReport).where(FinalReport.session_id == payload.session_id)
        ).first()
        if existing_after_race is None:
            raise
        return {"report_id": str(existing_after_race.id), "status": "already_exists"}
    db.refresh(report)

    return {"report_id": str(report.id), "status": "updated" if existing else "created"}


def _apply_report(report: FinalReport, proposal: FinalReportProposal) -> None:
    report.overall_score = proposal.overall_score
    report.technical_score = proposal.technical_score
    report.communication_score = proposal.communication_score
    report.culture_fit_score = proposal.culture_fit_score
    report.summary = proposal.summary
    report.strengths = proposal.strengths
    report.weaknesses = proposal.weaknesses
    report.recommendation = proposal.recommendation


def _looks_like_placeholder(report: FinalReport) -> bool:
    return (
        report.overall_score == 0.0
        and report.technical_score == 0.0
        and report.communication_score == 0.0
        and report.culture_fit_score == 0.0
    ) or "Skeleton report" in report.summary


def _candidate_segments(transcripts: list[TranscriptSegment]) -> list[TranscriptSegment]:
    """Return only the candidate's spoken turns.

    With multichannel capture, the candidate is labeled explicitly. For older
    single-channel sessions where diarization is unknown, we exclude turns that
    were clearly the interviewer and treat the rest as candidate evidence.
    """
    labeled = [
        s for s in transcripts if s.speaker == Speaker.CANDIDATE and s.text.strip()
    ]
    if labeled:
        return labeled
    return [
        s for s in transcripts if s.speaker != Speaker.INTERVIEWER and s.text.strip()
    ]


def _insufficient_evidence_report(candidate_words: int) -> FinalReportProposal:
    """Honest report for when the candidate did not actually answer."""
    summary = (
        "Not enough evidence to evaluate the candidate. The interview captured only "
        f"{candidate_words} word(s) of substantive candidate speech, so no technical, "
        "communication, or culture-fit assessment can be made. This is NOT a positive or "
        "negative judgment of the candidate's ability - there simply were no answers to score."
    )
    return FinalReportProposal(
        overall_score=0.0,
        technical_score=0.0,
        communication_score=0.0,
        culture_fit_score=0.0,
        summary=summary,
        strengths=[],
        weaknesses=[
            "The candidate did not provide substantive answers that could be evaluated.",
            "Re-run the interview and ensure the candidate's audio is captured (mic + tab).",
        ],
        recommendation=Recommendation.STRONG_NO_HIRE,
    )


def _fallback_report(
    candidate_segments: list[TranscriptSegment],
    hints: list[AIHint],
    job_description: str,
) -> FinalReportProposal:
    # `candidate_segments` already contains only the candidate's substantive turns.
    final_segments = [segment for segment in candidate_segments if segment.text.strip()]
    word_count = sum(len(segment.text.split()) for segment in final_segments)
    deltas = [hint.score_delta for hint in hints if hint.score_delta is not None]
    avg_delta = mean(deltas) if deltas else 0.0

    # Evidence-gated: scores grow only with actual candidate speech, and start
    # low. No answers => near-zero, never a flattering default.
    evidence_score = min(35.0, word_count / 6.0)
    base = 10.0 + evidence_score + max(-10.0, min(10.0, avg_delta))

    technical = _clamp_score(base + _keyword_bonus(final_segments, job_description))
    communication = _clamp_score(10.0 + min(40.0, word_count / 5.0))
    culture = _clamp_score(base)
    overall = _clamp_score((technical * 0.45) + (communication * 0.3) + (culture * 0.25))

    strengths = []
    if word_count >= 60:
        strengths.append("Engaged with questions and produced a substantive amount of speech.")

    weaknesses = []
    if word_count < 120:
        weaknesses.append("Candidate evidence is limited, so scores are conservative.")
    weaknesses.append("Final report used fallback scoring because model evaluation was unavailable.")

    if overall >= 75:
        recommendation = Recommendation.HIRE
    elif overall >= 50:
        recommendation = Recommendation.NO_HIRE
    else:
        recommendation = Recommendation.STRONG_NO_HIRE

    summary = (
        f"Fallback evaluation based on {len(final_segments)} candidate transcript segments "
        f"({word_count} words). Scores reflect only the candidate's own answers; the "
        "structured model report was unavailable at finalization time."
    )

    return FinalReportProposal(
        overall_score=overall,
        technical_score=technical,
        communication_score=communication,
        culture_fit_score=culture,
        summary=summary,
        strengths=strengths,
        weaknesses=weaknesses,
        recommendation=recommendation,
    )


def _keyword_bonus(segments: list[TranscriptSegment], job_description: str) -> float:
    transcript = " ".join(segment.text.lower() for segment in segments)
    jd_words = {
        word.strip(".,:;!?()[]{}\"'").lower()
        for word in job_description.split()
        if len(word.strip(".,:;!?()[]{}\"'")) > 5
    }
    if not jd_words or not transcript:
        return 0.0
    matches = sum(1 for word in jd_words if word in transcript)
    return min(15.0, matches * 2.5)


def _clamp_score(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 1)
