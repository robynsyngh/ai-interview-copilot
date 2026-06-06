"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AIHint, LiveFeedEvent, TranscriptSegment } from "@copilot/shared";
import { TranscriptPane } from "@/components/transcript-pane";
import { AssistPane, QuestionBankPane } from "@/components/hints-pane";
import { AskQuestionBox } from "@/components/ask-question-box";
import { connectLiveFeed } from "@/lib/ws";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type AssistMode = "interviewer" | "interviewee";

export default function LiveDashboardPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
      <LiveDashboardInner />
    </Suspense>
  );
}

function LiveDashboardInner() {
  const params = useSearchParams();
  const sessionId = params.get("sessionId");

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [hints, setHints] = useState<AIHint[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [assistMode, setAssistMode] = useState<AssistMode>("interviewer");

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    api
      .getSession(sessionId)
      .then((info) => {
        if (active) setAssistMode(info.mode);
      })
      .catch(() => {
        /* fall back to default mode */
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const changeMode = (mode: AssistMode) => {
    setAssistMode(mode);
    if (sessionId) {
      void api.setMode(sessionId, mode).catch(() => {
        /* keep optimistic UI; backend will retry on next toggle */
      });
    }
  };

  useEffect(() => {
    if (!sessionId) {
      setStatus("waiting-for-session");
      return;
    }

    let active = true;
    setError(null);
    const ws = connectLiveFeed(sessionId, (event) => {
      if (!active) return;
      if ((event as { type: string }).type === "heartbeat") return;
      const typed = event as LiveFeedEvent;
      switch (typed.type) {
        case "transcript.partial":
        case "transcript.final":
          setSegments((prev) => mergeSegment(prev, typed.segment));
          break;
        case "hint":
          setHints((prev) => [typed.hint, ...prev].slice(0, 50));
          break;
        case "session.status":
          setError(null);
          setStatus(typed.status);
          break;
        case "error":
          setError(typed.message);
          break;
      }
    });

    ws.onopen = () => {
      if (!active) return;
      setError(null);
      setStatus("connected");
    };
    ws.onclose = () => {
      if (!active) return;
      setStatus("disconnected");
    };
    ws.onerror = () => {
      if (!active) return;
      setError("WebSocket error - is the API running?");
    };

    return () => {
      active = false;
      ws.close();
    };
  }, [sessionId]);

  const tone = useMemo(() => {
    if (status === "active" || status === "connected") return "success" as const;
    if (status === "disconnected") return "danger" as const;
    return "default" as const;
  }, [status]);

  const finalize = async () => {
    if (!sessionId) return;
    try {
      await api.finalize(sessionId);
      setStatus("finalized");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Live interview</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Session: <code>{sessionId ?? "(none)"}</code>
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="inline-flex rounded-md border bg-muted p-1">
              <button
                type="button"
                onClick={() => changeMode("interviewer")}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  assistMode === "interviewer"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                Interviewer
              </button>
              <button
                type="button"
                onClick={() => changeMode("interviewee")}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  assistMode === "interviewee"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                Interviewee
              </button>
            </div>
            <Badge tone={tone}>{status}</Badge>
            <button
              onClick={finalize}
              disabled={!sessionId}
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Finalize report
            </button>
          </div>
        </CardHeader>
        {error && (
          <CardContent>
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          </CardContent>
        )}
        {!sessionId && (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Open this page with <code>?sessionId=&lt;uuid&gt;</code>, or start the session from
              the Chrome extension side panel.
            </p>
          </CardContent>
        )}
      </Card>

      <AskQuestionBox sessionId={sessionId} mode={assistMode} />

      <div className="grid gap-4 lg:grid-cols-3 lg:[grid-template-rows:minmax(0,1fr)] lg:h-[70vh]">
        <TranscriptPane segments={segments} />
        <AssistPane hints={hints} mode={assistMode} />
        <QuestionBankPane hints={hints} mode={assistMode} />
      </div>
    </div>
  );
}

function mergeSegment(prev: TranscriptSegment[], next: TranscriptSegment): TranscriptSegment[] {
  if (next.is_final) {
    return [...prev.filter((segment) => segment.is_final), next];
  }

  const idx = prev.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...prev, next];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}
