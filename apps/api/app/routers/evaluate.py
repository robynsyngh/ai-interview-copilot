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

# Stable marker written into the summary of a heuristic fallback report. It lets
# `_looks_like_placeholder` recognise a fallback report and replace it with a
# real AI report the next time the session is finalized (e.g. after quota resets).
_FALLBACK_SUMMARY_PREFIX = "Fallback evaluation"


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
        select(AIHint).where(AIHint.session_id == payload.session_id).order_by(AIHint.created_at)
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
    report.technical_analysis = proposal.technical_analysis
    report.communication_analysis = proposal.communication_analysis
    report.culture_analysis = proposal.culture_analysis
    report.strengths = proposal.strengths
    report.weaknesses = proposal.weaknesses
    report.recommendation = proposal.recommendation
    report.recommendation_rationale = proposal.recommendation_rationale


def _looks_like_placeholder(report: FinalReport) -> bool:
    return (
        (
            report.overall_score == 0.0
            and report.technical_score == 0.0
            and report.communication_score == 0.0
            and report.culture_fit_score == 0.0
        )
        or "Skeleton report" in report.summary
        or report.summary.startswith(_FALLBACK_SUMMARY_PREFIX)
    )


def _candidate_segments(transcripts: list[TranscriptSegment]) -> list[TranscriptSegment]:
    """Return only the candidate's spoken turns.

    With multichannel capture, the candidate is labeled explicitly. For older
    single-channel sessions where diarization is unknown, we exclude turns that
    were clearly the interviewer and treat the rest as candidate evidence.
    """
    labeled = [s for s in transcripts if s.speaker == Speaker.CANDIDATE and s.text.strip()]
    if labeled:
        return labeled
    return [s for s in transcripts if s.speaker != Speaker.INTERVIEWER and s.text.strip()]


def _insufficient_evidence_report(candidate_words: int) -> FinalReportProposal:
    """Honest report for when the candidate did not actually answer."""
    summary = (
        "Not enough evidence to evaluate the candidate. The interview captured only "
        f"{candidate_words} word(s) of substantive candidate speech, so no technical, "
        "communication, or culture-fit assessment can be made. This is NOT a positive or "
        "negative judgment of the candidate's ability - there simply were no answers to score."
    )
    no_evidence = (
        "No assessment is possible because the candidate did not provide substantive "
        "spoken answers during the interview."
    )
    return FinalReportProposal(
        overall_score=0.0,
        technical_score=0.0,
        communication_score=0.0,
        culture_fit_score=0.0,
        summary=summary,
        technical_analysis=no_evidence,
        communication_analysis=no_evidence,
        culture_analysis=no_evidence,
        strengths=[],
        weaknesses=[
            "The candidate did not provide substantive answers that could be evaluated.",
            "Re-run the interview and ensure the candidate's audio is captured (mic + tab).",
        ],
        recommendation=Recommendation.STRONG_NO_HIRE,
        recommendation_rationale=(
            "Recommending strong no-hire by default: there was insufficient candidate "
            "speech to assess suitability. Re-interview with working audio before deciding."
        ),
    )


def _fallback_report(
    candidate_segments: list[TranscriptSegment],
    hints: list[AIHint],
    job_description: str,
) -> FinalReportProposal:
    # `candidate_segments` already contains only the candidate's substantive turns.
    final_segments = [segment for segment in candidate_segments if segment.text.strip()]
    segment_count = len(final_segments)
    word_count = sum(len(segment.text.split()) for segment in final_segments)
    deltas = [hint.score_delta for hint in hints if hint.score_delta is not None]
    avg_delta = mean(deltas) if deltas else 0.0
    jd_matches = _jd_keyword_matches(final_segments, job_description)

    # Evidence-gated, on a 0-10 scale: scores grow only with actual candidate
    # speech and start low. No answers => near-zero, never a flattering default.
    evidence_score = min(3.5, word_count / 60.0)
    base = 1.0 + evidence_score + max(-1.0, min(1.0, avg_delta / 10.0))

    technical = _clamp_score(base + min(1.5, jd_matches * 0.25))
    communication = _clamp_score(1.0 + min(4.0, word_count / 50.0))
    culture = _clamp_score(base)
    overall = _clamp_score((technical * 0.45) + (communication * 0.3) + (culture * 0.25))

    strengths = []
    if word_count >= 60:
        strengths.append("Engaged with questions and produced a substantive amount of speech.")
    if jd_matches > 0:
        strengths.append(f"Used {jd_matches} term(s) that overlap with the job description.")

    weaknesses = []
    if word_count < 120:
        weaknesses.append("Candidate evidence is limited, so scores are conservative.")
    weaknesses.append(
        "This is heuristic fallback scoring, not an AI evaluation — re-finalize for a real read."
    )

    if overall >= 7.5:
        recommendation = Recommendation.HIRE
    elif overall >= 5.0:
        recommendation = Recommendation.NO_HIRE
    else:
        recommendation = Recommendation.STRONG_NO_HIRE

    # NOTE: keep the leading marker in sync with `_looks_like_placeholder` so a
    # fallback report can be replaced by a real AI report on the next finalize.
    summary = (
        f"{_FALLBACK_SUMMARY_PREFIX} from {segment_count} candidate transcript segment(s) "
        f"({word_count} words). All AI model providers were unavailable at finalization "
        "(rate-limited / quota exceeded), so these scores are a heuristic proxy based on how "
        "much the candidate spoke and how much their answers overlap the job description — they "
        "do NOT judge answer correctness. Re-finalize once provider quota resets for a real "
        "evidence-based evaluation."
    )

    technical_analysis = (
        f"Heuristic technical estimate ({technical:.1f}/10). This is a proxy from answer volume "
        f"and job-description overlap: {jd_matches} JD keyword(s) appeared across the candidate's "
        f"{word_count} words. It does NOT assess whether the answers were correct or deep — the "
        "AI evaluator that reads answer content was unavailable. Re-finalize for a true technical "
        "read."
    )
    communication_analysis = (
        f"Heuristic communication estimate ({communication:.1f}/10), based purely on speaking "
        f"volume: {word_count} words across {segment_count} turn(s). Clarity, structure, and "
        "articulation were not actually analyzed because the AI evaluator was unavailable."
    )
    culture_analysis = (
        f"Heuristic culture-fit estimate ({culture:.1f}/10), derived from overall engagement"
        + (f" and live interviewer signals (avg {avg_delta:+.1f})" if deltas else "")
        + ". No genuine culture-fit evidence was assessed because the AI evaluator was "
        "unavailable at finalization."
    )
    recommendation_rationale = (
        f"The '{recommendation.value}' recommendation is provisional: it was computed by "
        "heuristic fallback scoring, not the AI evaluator (all model providers were rate-limited "
        "at finalization). Re-finalize this report once provider quota resets before making a "
        "hiring decision."
    )

    return FinalReportProposal(
        overall_score=overall,
        technical_score=technical,
        communication_score=communication,
        culture_fit_score=culture,
        summary=summary,
        technical_analysis=technical_analysis,
        communication_analysis=communication_analysis,
        culture_analysis=culture_analysis,
        strengths=strengths,
        weaknesses=weaknesses,
        recommendation=recommendation,
        recommendation_rationale=recommendation_rationale,
    )


def _jd_keyword_matches(segments: list[TranscriptSegment], job_description: str) -> int:
    """Count distinct job-description keywords the candidate actually used."""
    transcript = " ".join(segment.text.lower() for segment in segments)
    jd_words = {
        word.strip(".,:;!?()[]{}\"'").lower()
        for word in job_description.split()
        if len(word.strip(".,:;!?()[]{}\"'")) > 5
    }
    if not jd_words or not transcript:
        return 0
    return sum(1 for word in jd_words if word in transcript)


def _clamp_score(value: float) -> float:
    return round(max(0.0, min(10.0, value)), 1)
