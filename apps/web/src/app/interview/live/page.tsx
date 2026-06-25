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
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

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
  const [modeSaving, setModeSaving] = useState<AssistMode | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const { toast } = useToast();

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

  const changeMode = async (mode: AssistMode) => {
    if (!sessionId || modeSaving || mode === assistMode) return;
    const previous = assistMode;
    setAssistMode(mode);
    setModeSaving(mode);
    setError(null);
    try {
      await api.setMode(sessionId, mode);
      toast({
        title: "Assist mode updated",
        description: `Switched to ${mode === "interviewer" ? "interviewer rubric" : "interviewee answer"} mode.`,
        tone: "success",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAssistMode(previous);
      setError(message);
      toast({ title: "Could not update mode", description: message, tone: "error" });
    } finally {
      setModeSaving(null);
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
          setHints((prev) => mergeHint(prev, typed.hint));
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
      setStatus((prev) => (prev === "completed" || prev === "finalized" ? prev : "disconnected"));
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
    if (status === "active" || status === "connected" || status === "completed" || status === "finalized") {
      return "success" as const;
    }
    if (status === "disconnected") return "danger" as const;
    return "default" as const;
  }, [status]);

  // The interview is over (stop pressed) once the backend reports "completed".
  // The report is only "finalized" after a successful finalize call (client-only
  // status) - stopping the interview must NOT lock the finalize button.
  const interviewEnded = status === "completed" || status === "finalized";
  const reportFinalized = status === "finalized";

  const finalize = async () => {
    if (!sessionId || isFinalizing || reportFinalized) return;
    setIsFinalizing(true);
    setError(null);
    try {
      await api.finalize(sessionId);
      setStatus("finalized");
      toast({
        title: "Report finalized",
        description: "The interview report has been generated and saved.",
        tone: "success",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Could not finalize report", description: message, tone: "error" });
    } finally {
      setIsFinalizing(false);
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void changeMode("interviewer")}
                disabled={!sessionId || !!modeSaving}
                loading={modeSaving === "interviewer"}
                className={`h-7 rounded px-3 py-1 text-xs ${
                  assistMode === "interviewer"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                Interviewer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void changeMode("interviewee")}
                disabled={!sessionId || !!modeSaving}
                loading={modeSaving === "interviewee"}
                className={`h-7 rounded px-3 py-1 text-xs ${
                  assistMode === "interviewee"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                Interviewee
              </Button>
            </div>
            <Badge tone={tone}>{status}</Badge>
            <Button
              onClick={() => void finalize()}
              disabled={!sessionId || reportFinalized}
              loading={isFinalizing}
              loadingLabel="Finalizing…"
              className="h-9 px-3"
            >
              {reportFinalized ? "Report finalized" : "Finalize report"}
            </Button>
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

      <AskQuestionBox
        sessionId={sessionId}
        mode={assistMode}
        disabled={interviewEnded}
        onTranscriptSegment={(segment) => setSegments((prev) => mergeSegment(prev, segment))}
        onHint={(hint) => setHints((prev) => mergeHint(prev, hint))}
      />

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
    return [...prev.filter((segment) => segment.is_final && segment.id !== next.id), next];
  }

  const idx = prev.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...prev, next];
  const copy = prev.slice();
  copy[idx] = next;
  return copy;
}

function mergeHint(prev: AIHint[], next: AIHint): AIHint[] {
  return [next, ...prev.filter((hint) => hint.id !== next.id)].slice(0, 50);
}
