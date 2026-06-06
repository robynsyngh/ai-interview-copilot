# syntax=docker/dockerfile:1.7

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./

RUN pip install --upgrade pip \
    && pip install \
        "fastapi>=0.115.0" \
        "uvicorn[standard]>=0.32.0" \
        "websockets>=13.1" \
        "sqlmodel>=0.0.22" \
        "psycopg[binary]>=3.2.3" \
        "pydantic>=2.9.2" \
        "pydantic-settings>=2.6.1" \
        "python-dotenv>=1.0.1" \
        "httpx>=0.27.2" \
        "python-multipart>=0.0.12" \
        "deepgram-sdk>=3.7.7,<4.0.0" \
        "structlog>=24.4.0" \
        "pypdf>=5.1.0" \
        "python-docx>=1.1.2"

COPY app ./app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
