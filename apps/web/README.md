# `apps/web` — Next.js 15 dashboard

The pink lower band of the DFD. Owns:

- **P7** Past reviews (`src/app/reports/page.tsx`) — server component pulling from `/api/reports`
- **P8** Co-Pilot dashboard (`src/app/interview/live/page.tsx`) — subscribes to `/api/live-feed/{session_id}` over WebSocket and renders transcript + hint streams in real time

## Stack

- Next.js 15 App Router (React 19, server components + `"use client"` islands)
- Tailwind CSS 3 with hand-rolled shadcn-style primitives in `src/components/ui`
- Shared types from `@copilot/shared` (workspace package)

## Develop

From the **repo root**:

```bash
pnpm install
pnpm dev:web
```

Then visit:

- `http://localhost:3000` landing
- `http://localhost:3000/interview/live?sessionId=<uuid>` live dashboard
- `http://localhost:3000/reports` past reviews

The dashboard expects the FastAPI server (Docker Compose `api` service) at
`http://localhost:8000`. Override via `NEXT_PUBLIC_API_BASE_URL` and
`NEXT_PUBLIC_WS_BASE_URL` in `apps/web/.env.local`.
