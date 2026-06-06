# `apps/api` — FastAPI backend

The orange middle band of the DFD. Owns:

- **D1** PostgreSQL via SQLModel (`app/models/*.py`)
- **P3** WebSocket router (`app/routers/live_stream.py`)
- **P4** Deepgram streaming transcriber (`app/services/deepgram.py`)
- **P5** GitHub Models real-time evaluator (`app/services/github_models.py`)
- **P6** Frontend dispatcher / live-feed broadcaster (`app/services/dispatcher.py` + `app/routers/live_feed.py`)

## Endpoints

| Method | Path                              | Purpose                                  | DFD edge       |
| ------ | --------------------------------- | ---------------------------------------- | -------------- |
| POST   | `/api/session`                    | Register a new `InterviewSession`        | Side panel → D1 |
| WS     | `/api/live-stream/{session_id}`   | Inbound binary audio + control frames    | P1 → P3 → P4   |
| WS     | `/api/live-feed/{session_id}`     | Outbound transcript + hint events        | P6 → P8        |
| POST   | `/api/evaluate`                   | Finalize a session, write `FinalReport`  | P8 → D1        |
| GET    | `/api/reports`                    | List sessions + reports                  | D1 → P7        |
| GET    | `/api/reports/{session_id}`       | One session’s detail                     | D1 → P7        |
| GET    | `/health`                         | Liveness probe                           | meta           |

## Running

### Via Docker Compose (recommended)

From the **repo root**:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f api
```

API will be on `http://localhost:8000`, pgAdmin on `http://localhost:5050`.

### Locally with `uv` (optional)

```bash
# install uv once: https://docs.astral.sh/uv/getting-started/installation/
cd apps/api
uv sync
uv run uvicorn app.main:app --reload
```

## Skeleton notes

- Deepgram and GitHub Models clients are **stubbed** — no live API calls.
  - `services/deepgram.py` emits a synthetic transcript every second when
    `DEEPGRAM_API_KEY` is empty so the rest of the pipeline can be exercised.
  - `services/github_models.py` no-ops when `GITHUB_MODELS_TOKEN` is empty.
- DB schema is created via `SQLModel.metadata.create_all` on startup.
  Swap to Alembic before the first schema change.
