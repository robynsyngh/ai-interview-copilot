"use client";

import { useState } from "react";
import { SendHorizonal } from "lucide-react";
import type { AIHint, TranscriptSegment } from "@copilot/shared";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

interface Props {
  sessionId: string | null;
  mode: "interviewer" | "interviewee";
  disabled?: boolean;
  onHint: (hint: AIHint) => void;
  onTranscriptSegment: (segment: TranscriptSegment) => void;
}

export function AskQuestionBox({
  disabled = false,
  sessionId,
  mode,
  onHint,
  onTranscriptSegment,
}: Props) {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const isInterviewee = mode === "interviewee";
  const inputDisabled = disabled || !sessionId || status === "loading";

  const submit = async () => {
    const trimmed = question.trim();
    if (!trimmed || !sessionId || disabled) return;
    setStatus("loading");
    setError(null);
    try {
      const result = await api.askQuestion(sessionId, trimmed);
      onTranscriptSegment(result.segment);
      onHint(result.hint);
      setQuestion("");
      setStatus("done");
      toast({
        title: isInterviewee ? "Answer generated" : "Rubric generated",
        description: "The question was added to the transcript and saved for the final report.",
        tone: "success",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("error");
      setError(message);
      toast({ title: "Could not process question", description: message, tone: "error" });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <Card className="animate-card-in">
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
          onChange={(event) => {
            setQuestion(event.target.value);
            if (status !== "idle") {
              setStatus("idle");
              setError(null);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Given a table orders(id, user_id, amount), write a SQL query for the top spender per month."
          rows={3}
          disabled={inputDisabled}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {status === "loading" && "Generating…"}
            {status === "done" && "Answer added to the assist panel below."}
            {status === "error" && <span className="text-destructive">{error}</span>}
            {disabled && "This session is finalized. Start a new interview to ask more questions."}
            {status === "idle" && !disabled && (
              <span className="hidden sm:inline">Press ⌘/Ctrl + Enter to submit.</span>
            )}
          </div>
          <Button
            size="sm"
            onClick={submit}
            disabled={disabled || !sessionId || status === "loading" || question.trim().length === 0}
            loading={status === "loading"}
            loadingLabel={isInterviewee ? "Generating…" : "Building rubric…"}
          >
            <SendHorizonal className="mr-1.5 h-4 w-4" aria-hidden />
            {isInterviewee ? "Get answer" : "Get rubric"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
