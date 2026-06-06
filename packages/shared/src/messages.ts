/**
 * WebSocket / HTTP message contracts shared by all 3 runtimes.
 *
 * The DFD defines two distinct WebSocket channels:
 *   1. Extension <-> FastAPI  (`/api/live-stream/{id}`) - inbound binary audio + control frames
 *   2. FastAPI  <-> Next.js   (`/api/live-feed/{id}`)   - outbound transcript & hint events (P6)
 *
 * Field names are `snake_case` to mirror the FastAPI/Pydantic wire format.
 */

import type { AIHint, AssistMode, TranscriptSegment } from "./entities";

// ---------- Extension -> API control frames (sent over WS as JSON text) ------

export type ExtensionToApiMessage =
  | { type: "session.start"; session_id: string; sample_rate: number }
  | { type: "session.stop"; session_id: string }
  | { type: "session.heartbeat"; session_id: string; ts: number };

// Audio frames are sent as raw binary (ArrayBuffer / Blob) - not JSON.

// ---------- API -> Frontend live-feed events (P6 broadcast) ------------------

export type LiveFeedEvent =
  | { type: "transcript.partial"; segment: TranscriptSegment }
  | { type: "transcript.final"; segment: TranscriptSegment }
  | { type: "hint"; hint: AIHint }
  | { type: "session.status"; session_id: string; status: string }
  | { type: "error"; message: string; code?: string };

// ---------- REST DTOs --------------------------------------------------------

export interface CreateSessionRequest {
  candidate_name?: string | null;
  job_description: string;
  resume_text: string;
  mode?: AssistMode;
}

export interface CreateSessionResponse {
  session_id: string;
  live_stream_url: string;
  live_feed_url: string;
}

export interface SessionInfoResponse {
  session_id: string;
  candidate_name: string | null;
  status: string;
  mode: AssistMode;
}

export interface UpdateModeRequest {
  mode: AssistMode;
}

export interface FinalizeSessionRequest {
  session_id: string;
}

// ---------- REST: /api/documents/extract -------------------------------------

export type DocumentKind = "pdf" | "docx" | "text";

export interface DocumentExtractResponse {
  text: string;
  kind: DocumentKind;
  filename: string | null;
  chars: number;
}
