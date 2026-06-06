"""POST /api/documents/extract - turn an uploaded resume/JD file into text.

The extension side panel lets the user drag-and-drop a PDF/DOCX/TXT into the
job-description or resume field. The file is posted here and we return the
extracted plain text, which the UI drops straight into the textarea so the rest
of the session-creation flow is unchanged.
"""

from __future__ import annotations

import anyio
import structlog
from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.schemas.messages import DocumentExtractResponse
from app.services.document_extract import (
    MAX_FILE_BYTES,
    DocumentError,
    extract_text,
)

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.post("/extract", response_model=DocumentExtractResponse)
async def extract_document(
    file: UploadFile = File(..., description="A PDF, Word .docx, or .txt resume/JD."),
) -> DocumentExtractResponse:
    data = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File is too large. Max is {MAX_FILE_BYTES // (1024 * 1024)} MB.",
        )

    try:
        # Parsing is synchronous + CPU-bound; keep it off the event loop.
        text, kind = await anyio.to_thread.run_sync(
            lambda: extract_text(
                data, filename=file.filename, content_type=file.content_type
            )
        )
    except DocumentError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface a clean message, log the detail
        log.warning("document_extract_failed", filename=file.filename, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not read that file. Try a different export or paste the text.",
        ) from exc

    log.info("document_extracted", filename=file.filename, kind=kind.value, chars=len(text))
    return DocumentExtractResponse(
        text=text,
        kind=kind.value,
        filename=file.filename,
        chars=len(text),
    )
