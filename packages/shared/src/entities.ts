/**
 * Mirror of the Postgres entities (D1 in the DFD).
 *
 * Field names are intentionally `snake_case` to match the JSON the FastAPI
 * backend emits. Keep these in lockstep with `apps/api/app/models/*.py` and
 * the JSON shapes built in `apps/api/app/routers/*.py`.
 */

export type SessionStatus = "pending" | "active" | "completed" | "failed";

export type AssistMode = "interviewer" | "interviewee";

export interface InterviewSession {
  id: string;
  candidate_name: string | null;
  job_description: string;
  resume_text: string;
  mode: AssistMode;
  status: SessionStatus;
  created_at: string;
  completed_at: string | null;
}

export type Speaker = "candidate" | "interviewer" | "unknown";

export interface TranscriptSegment {
  id: string;
  session_id: string;
  speaker: Speaker;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  created_at: string;
}

export type HintKind =
  | "follow_up_question"
  | "clarifying_prompt"
  | "red_flag"
  | "strength_signal"
  | "score_update";

export interface AIHint {
  id: string;
  session_id: string;
  kind: HintKind;
  content: string;
  score_delta: number | null;
  created_at: string;
}

export type Recommendation = "strong_hire" | "hire" | "no_hire" | "strong_no_hire";

export interface FinalReport {
  id: string;
  session_id: string;
  overall_score: number;
  technical_score: number;
  communication_score: number;
  culture_fit_score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendation: Recommendation;
  created_at: string;
}
