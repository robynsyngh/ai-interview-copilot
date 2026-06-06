"""GET /api/reports - list past sessions and their final reports (P7)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db import get_session
from app.models.report import FinalReport
from app.models.session import InterviewSession

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("")
async def list_reports(db: Session = Depends(get_session)) -> list[dict[str, Any]]:
    rows = db.exec(
        select(InterviewSession, FinalReport)
        .join(FinalReport, FinalReport.session_id == InterviewSession.id, isouter=True)
        .order_by(InterviewSession.created_at.desc())
    ).all()

    return [
        {
            "session_id": str(session.id),
            "candidate_name": session.candidate_name,
            "status": session.status.value,
            "created_at": session.created_at.isoformat(),
            "completed_at": session.completed_at.isoformat() if session.completed_at else None,
            "report": _serialize_report(report),
        }
        for session, report in rows
    ]


@router.delete("")
async def delete_all_reports(db: Session = Depends(get_session)) -> dict[str, int]:
    """Delete every interview session (and its cascaded report/hints/transcripts)."""
    sessions = db.exec(select(InterviewSession)).all()
    deleted = 0
    for session in sessions:
        db.delete(session)
        deleted += 1
    db.commit()
    return {"deleted": deleted}


@router.delete("/{session_id}")
async def delete_report(session_id: uuid.UUID, db: Session = Depends(get_session)) -> dict[str, str]:
    """Delete a single interview session and all of its associated data."""
    session = db.get(InterviewSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"deleted": str(session_id)}


@router.get("/{session_id}")
async def get_report(session_id: uuid.UUID, db: Session = Depends(get_session)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    report = db.exec(
        select(FinalReport).where(FinalReport.session_id == session_id)
    ).first()
    return {
        "session_id": str(session.id),
        "candidate_name": session.candidate_name,
        "job_description": session.job_description,
        "status": session.status.value,
        "created_at": session.created_at.isoformat(),
        "completed_at": session.completed_at.isoformat() if session.completed_at else None,
        "report": _serialize_report(report),
    }


def _serialize_report(report: FinalReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    return {
        "id": str(report.id),
        "overall_score": report.overall_score,
        "technical_score": report.technical_score,
        "communication_score": report.communication_score,
        "culture_fit_score": report.culture_fit_score,
        "summary": report.summary,
        "strengths": report.strengths,
        "weaknesses": report.weaknesses,
        "recommendation": report.recommendation.value,
        "created_at": report.created_at.isoformat(),
    }
