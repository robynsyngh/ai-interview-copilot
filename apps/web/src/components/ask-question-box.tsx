"use client";

import { useState } from "react";
import { SendHorizonal } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Props {
  sessionId: string | null;
  mode: "interviewer" | "interviewee";
}

export function AskQuestionBox({ sessionId, mode }: Props) {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const isInterviewee = mode === "interviewee";

  const submit = async () => {
    const trimmed = question.trim();
    if (!trimmed || !sessionId) return;
    setStatus("loading");
    setError(null);
    try {
      await api.askQuestion(sessionId, trimmed);
      setQuestion("");
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {isInterviewee ? "Paste a question → get your answer" : "Paste a question → get a rubric"}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {isInterviewee
            ? "Paste any question the interviewer asks. A ready-to-say answer grounded in your resume appears in the assist panel below."
            : "Paste a question to generate an expected-answer rubric. It appears in the assist panel below."}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Given a table orders(id, user_id, amount), write a SQL query for the top spender per month."
          rows={3}
          disabled={!sessionId}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {status === "loading" && "Generating…"}
            {status === "done" && "Answer added to the assist panel below."}
            {status === "error" && <span className="text-destructive">{error}</span>}
            {status === "idle" && (
              <span className="hidden sm:inline">Press ⌘/Ctrl + Enter to submit.</span>
            )}
          </div>
          <Button
            size="sm"
            onClick={submit}
            disabled={!sessionId || status === "loading" || question.trim().length === 0}
          >
            <SendHorizonal className="mr-1.5 h-4 w-4" aria-hidden />
            {isInterviewee ? "Get answer" : "Get rubric"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
