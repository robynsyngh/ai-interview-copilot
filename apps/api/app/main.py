"""FastAPI application entry-point.

Wires together the four routers that map to the DFD edges:
    - POST /api/session       (P2/P3 ingress + D1 write)
    - WS   /api/live-stream   (P3 -> P4 binary audio fan-in)
    - WS   /api/live-feed     (P6 -> P8 outbound events)
    - POST /api/evaluate      (session finalization)
    - GET  /api/reports       (P7 historical view)
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import init_db
from app.routers import documents, evaluate, live_feed, live_stream, reports, session

settings = get_settings()


def _configure_logging() -> None:
    logging.basicConfig(level=settings.log_level)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(settings.log_level)
        ),
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _configure_logging()
    log = structlog.get_logger("app.lifespan")
    try:
        init_db()
        log.info("db_ready")
    except Exception as exc:  # noqa: BLE001 - surface but do not crash on first boot
        log.warning("db_init_skipped", error=str(exc))
    yield
    log.info("shutdown")


app = FastAPI(
    title="AI Interview Co-Pilot API",
    version="0.1.0",
    description="FastAPI backend wiring the audio + transcript + hint pipeline.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", tags=["meta"])
async def root() -> dict[str, object]:
    return {
        "service": "ai-interview-copilot-api",
        "version": app.version,
        "docs": "/docs",
        "health": "/health",
        "endpoints": [
            "POST /api/session",
            "POST /api/documents/extract",
            "WS   /api/live-stream/{session_id}",
            "WS   /api/live-feed/{session_id}",
            "POST /api/evaluate",
            "GET  /api/reports",
            "GET  /api/reports/{session_id}",
        ],
    }


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


app.include_router(session.router)
app.include_router(documents.router)
app.include_router(live_stream.router)
app.include_router(live_feed.router)
app.include_router(evaluate.router)
app.include_router(reports.router)
