# AI Interview Co-Pilot

A monorepo skeleton implementing the Data Flow Diagram you sketched: a Chrome
extension captures meeting audio, a FastAPI backend streams it through Deepgram
Nova-2 and asks GitHub Models for real-time interviewing hints, a Next.js
dashboard renders transcripts + hints live, and PostgreSQL holds the trail.

> **Status:** scaffolding only. The audio path, Deepgram client, and GitHub
> Models call site are wired through with stub implementations so the full
> control plane (sessions, websockets, dispatcher, DB writes, REST + Next.js
> pages) is reviewable end-to-end. Drop in the API keys and replace the
> three TODOs to go live.

## Repo layout

```
ai-interview-copilot/
├── apps/
│   ├── api/          # FastAPI + SQLModel (P3, P4, P5, P6, D1)
│   ├── web/          # Next.js 15 dashboard (P7, P8)
│   └── extension/    # Chrome MV3 extension (P1, P2)
├── packages/
│   └── shared/       # TypeScript types shared by web + extension
├── docker-compose.yml
├── .env.example
├── pnpm-workspace.yaml
└── package.json
```

## DFD → file map

| DFD element                         | Lives in                                                  |
| ----------------------------------- | --------------------------------------------------------- |
| **P1** Audio Capture (Offscreen)    | `apps/extension/src/offscreen/offscreen.ts`               |
| **P2** Session Initializer (panel)  | `apps/extension/src/sidepanel/App.tsx`                    |
| **P3** WebSocket Router             | `apps/api/app/routers/live_stream.py`                     |
| **P4** Streaming Transcriber        | `apps/api/app/services/deepgram.py`                       |
| **P5** Real-Time Evaluator          | `apps/api/app/services/github_models.py`                  |
| **P6** Frontend Dispatch            | `apps/api/app/services/dispatcher.py` + `routers/live_feed.py` |
| **P7** Past Reviews View            | `apps/web/src/app/reports/page.tsx`                       |
| **P8** Co-Pilot Dashboard           | `apps/web/src/app/interview/live/page.tsx`                |
| **D1** Postgres entities            | `apps/api/app/models/*.py`                                |

## Prerequisites

- Node 20+ (you have 22 ✓)
- pnpm 9+ — already activated via `corepack enable`
- Docker / Docker Desktop
- (optional) Python 3.11 + [uv](https://docs.astral.sh/uv/) for running the API on the host

## Quick start

```bash
# 1. Configure environment
cp .env.example .env

# 2. Install JS deps for all workspace packages
pnpm install

# 3. Bring up Postgres + pgAdmin + the FastAPI API
docker compose up -d --build
docker compose logs -f api    # wait for "Application startup complete"

# 4. In a second terminal, run the Next.js dashboard
pnpm dev:web                  # http://localhost:3000

# 5. In a third terminal, build the Chrome extension
pnpm dev:ext                  # produces apps/extension/dist (watch mode)
#    then load apps/extension/dist as an unpacked extension at chrome://extensions
```

## Service URLs

| Service       | URL                                  |
| ------------- | ------------------------------------ |
| FastAPI       | http://localhost:8000                |
| FastAPI docs  | http://localhost:8000/docs           |
| Next.js       | http://localhost:3000                |
| pgAdmin       | http://localhost:5050 (admin@copilot.local / admin) |
| Postgres      | localhost:5432 (copilot / copilot_dev_password)     |

## Next steps to go live

1. **Audio capture** — wire `chrome.tabCapture` + an `AudioWorklet` PCM16
   downsampler in `apps/extension/src/offscreen/offscreen.ts` (TODO is marked
   inline).
2. **Deepgram** — fill in `DEEPGRAM_API_KEY` and replace `_FakeStream` with the
   real `DeepgramClient.listen.asynclive` call in
   `apps/api/app/services/deepgram.py`.
3. **GitHub Models** — fill in `GITHUB_MODELS_TOKEN` and implement the
   `chat/completions` POST in `apps/api/app/services/github_models.py`. Hook
   the result into `routers/live_stream.py` so hints get persisted and
   dispatched.
4. **Final report** — replace the placeholder write in
   `apps/api/app/routers/evaluate.py` with a real GitHub Models call that
   summarizes the saved transcript history.

## Useful scripts

```bash
pnpm typecheck            # tsc --noEmit across all workspace packages
pnpm build                # production build for all JS packages
pnpm docker:up            # docker compose up -d
pnpm docker:down          # docker compose down
pnpm docker:reset         # destroy volumes + rebuild
pnpm docker:logs          # follow API logs
```
