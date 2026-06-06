import type {
  AssistMode,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionInfoResponse,
} from "@copilot/shared";

// The browser talks to the host-published API (localhost:8000). But during
// server-side rendering the code runs INSIDE the web container, where
// `localhost:8000` is the web container itself, not the API. There it must use
// the in-network service URL (e.g. http://api:8000) from the server-only
// `API_INTERNAL_BASE_URL` env var. Falling back to the public URL keeps local
// `next dev` (no container) working unchanged.
function apiBaseUrl(): string {
  const publicUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  if (typeof window === "undefined") {
    return process.env.API_INTERNAL_BASE_URL ?? publicUrl;
  }
  return publicUrl;
}

export interface ReportListItem {
  session_id: string;
  candidate_name: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  report: ReportSummary | null;
}

export interface ReportSummary {
  id: string;
  overall_score: number;
  technical_score: number;
  communication_score: number;
  culture_fit_score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendation: "strong_hire" | "hire" | "no_hire" | "strong_no_hire";
  created_at: string;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  createSession: (payload: CreateSessionRequest) =>
    http<CreateSessionResponse>("/api/session", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  finalize: (sessionId: string) =>
    http<{ report_id: string; status: string }>("/api/evaluate", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    }),
  listReports: () => http<ReportListItem[]>("/api/reports"),
  deleteReport: (sessionId: string) =>
    http<{ deleted: string }>(`/api/reports/${sessionId}`, {
      method: "DELETE",
    }),
  deleteAllReports: () =>
    http<{ deleted: number }>("/api/reports", {
      method: "DELETE",
    }),
  getSession: (sessionId: string) =>
    http<SessionInfoResponse>(`/api/session/${sessionId}`),
  setMode: (sessionId: string, mode: AssistMode) =>
    http<SessionInfoResponse>(`/api/session/${sessionId}/mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }),
  askQuestion: (sessionId: string, question: string) =>
    http<{ hint: AIHintPayload }>(`/api/session/${sessionId}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
};

export interface AIHintPayload {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  score_delta: number | null;
  created_at: string;
}
