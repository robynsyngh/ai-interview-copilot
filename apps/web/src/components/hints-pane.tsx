"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { AIHint } from "@copilot/shared";
import { Lightbulb, AlertTriangle, Sparkles, MessagesSquare, TrendingUp } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props {
  hints: AIHint[];
  mode: "interviewer" | "interviewee";
}

const ICON_BY_KIND = {
  follow_up_question: MessagesSquare,
  clarifying_prompt: Lightbulb,
  red_flag: AlertTriangle,
  strength_signal: Sparkles,
  score_update: TrendingUp,
} as const;

const TONE_BY_KIND = {
  follow_up_question: "default" as const,
  clarifying_prompt: "default" as const,
  red_flag: "danger" as const,
  strength_signal: "success" as const,
  score_update: "warning" as const,
};

// All three dashboard columns render newest-first (LIFO). We sort by
// `created_at` explicitly rather than trusting arrival order, because the live
// feed replays history newest-first and then streams new events on top.
function newestFirst(hints: AIHint[]): AIHint[] {
  return [...hints].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Column 2 — live AI output: the ready-to-say answer / evaluation rubric for the
 * question being asked right now, plus runtime follow-up prompts.
 */
export function AssistPane({ hints, mode }: Props) {
  const sorted = useMemo(() => newestFirst(hints), [hints]);
  const answers = sorted.filter((hint) => parseAnswerHint(hint.content));
  const rubrics = sorted.filter((hint) => parseRubricHint(hint.content));
  const runtimeHints = sorted.filter(
    (hint) =>
      !parseQuestionBankHint(hint.content) &&
      !parseRubricHint(hint.content) &&
      !parseAnswerHint(hint.content),
  );
  const primaryItems = mode === "interviewee" ? answers : rubrics;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>
          {mode === "interviewer" ? "AI assist & follow-ups" : "Your answers & follow-ups"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-0">
        <div className="space-y-6 px-6 pb-6">
          <section className="space-y-3">
            <SectionTitle
              title={mode === "interviewer" ? "Expected Answer / Rubric" : "Your Answer (say this)"}
              count={primaryItems.length}
            />
            {primaryItems.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                {mode === "interviewer"
                  ? "When an interviewer question is detected, the expected answer and scoring rubric will appear here."
                  : "When a question is detected, a ready-to-say answer grounded in your resume will appear here."}
              </p>
            ) : mode === "interviewee" ? (
              <CurrentAndPrevious
                items={answers}
                renderCurrent={(hint) => <AnswerItem key={hint.id} hint={hint} current />}
                renderPrevious={(hint) => <AnswerItem key={hint.id} hint={hint} />}
              />
            ) : (
              <CurrentAndPrevious
                items={rubrics}
                renderCurrent={(hint) => <RubricItem key={hint.id} hint={hint} mode={mode} current />}
                renderPrevious={(hint) => <RubricItem key={hint.id} hint={hint} mode={mode} />}
              />
            )}
          </section>

          <section className="space-y-3">
            <SectionTitle
              title={mode === "interviewer" ? "Runtime Follow-ups" : "Live Practice Prompts"}
              count={runtimeHints.length}
            />
            {runtimeHints.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                {mode === "interviewer"
                  ? "Follow-ups based on the candidate's live answers will appear here."
                  : "Practice prompts based on the live conversation will appear here."}
              </p>
            ) : (
              <ul className="space-y-3">
                {runtimeHints.map((hint) => (
                  <RuntimeHintItem key={hint.id} hint={hint} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Column 3 — predefined question bank generated from the JD + resume at session
 * start. JD-driven technologies, balanced ~50/50 between depth/logic and syntax.
 */
const DIFFICULTY_ORDER: Record<"Easy" | "Medium" | "Hard", number> = {
  Easy: 0,
  Medium: 1,
  Hard: 2,
};

interface BankSection {
  name: string;
  items: AIHint[];
}

/**
 * Group the flat question-bank hints into per-technology sections (Node.js,
 * Angular, …, JavaScript Fundamentals, Data Structures & Algorithms). Sections
 * keep their insertion order (oldest first = the order the backend emitted them,
 * Node.js first); questions inside each section are ordered Easy → Hard.
 */
function groupBySection(hints: AIHint[]): BankSection[] {
  const ascending = [...hints].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const sections = new Map<string, AIHint[]>();
  for (const hint of ascending) {
    const parsed = parseQuestionBankHint(hint.content);
    if (!parsed) continue;
    const bucket = sections.get(parsed.skill);
    if (bucket) bucket.push(hint);
    else sections.set(parsed.skill, [hint]);
  }

  return [...sections.entries()].map(([name, items]) => ({
    name,
    items: items.sort((a, b) => {
      const da = parseQuestionBankHint(a.content)!.difficulty;
      const db = parseQuestionBankHint(b.content)!.difficulty;
      const byDifficulty = DIFFICULTY_ORDER[da] - DIFFICULTY_ORDER[db];
      return byDifficulty !== 0 ? byDifficulty : a.created_at.localeCompare(b.created_at);
    }),
  }));
}

export function QuestionBankPane({ hints, mode }: Props) {
  const questionBank = useMemo(
    () => hints.filter((hint) => parseQuestionBankHint(hint.content)),
    [hints],
  );
  const sections = useMemo(() => groupBySection(questionBank), [questionBank]);
  const [askedIds, setAskedIds] = useState<Set<string>>(new Set());

  const toggleAsked = (id: string) => {
    setAskedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const total = questionBank.length;
  const askedCount = questionBank.reduce((n, hint) => n + (askedIds.has(hint.id) ? 1 : 0), 0);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>
          {mode === "interviewer" ? "Question Bank (JD + Resume)" : "Practice Question Bank"}
        </CardTitle>
        {total > 0 && (
          <span className="text-xs text-muted-foreground">
            {askedCount}/{total} asked
          </span>
        )}
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-0">
        <div className="space-y-4 px-6 pb-6">
          {total === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Questions tailored to the job description and resume will appear here.
            </p>
          ) : (
            sections.map((section) => (
              <SectionBlock
                key={section.name}
                section={section}
                askedIds={askedIds}
                onToggleAsked={toggleAsked}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SectionBlock({
  section,
  askedIds,
  onToggleAsked,
}: {
  section: BankSection;
  askedIds: Set<string>;
  onToggleAsked: (id: string) => void;
}) {
  const asked = section.items.reduce((n, hint) => n + (askedIds.has(hint.id) ? 1 : 0), 0);
  return (
    <details open className="group rounded-md border bg-card/30">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2">
        <span className="flex items-center gap-2">
          <Badge tone={categoryTone(section.name)}>{section.name}</Badge>
          <span className="text-xs text-muted-foreground">
            {section.items.length} question{section.items.length === 1 ? "" : "s"} · Easy → Hard
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {asked}/{section.items.length}
        </span>
      </summary>
      <ul className="space-y-2 px-3 pb-3">
        {section.items.map((hint) => (
          <QuestionBankItem
            key={hint.id}
            hint={hint}
            asked={askedIds.has(hint.id)}
            onToggleAsked={onToggleAsked}
          />
        ))}
      </ul>
    </details>
  );
}

function CurrentAndPrevious({
  items,
  renderCurrent,
  renderPrevious,
}: {
  items: AIHint[];
  renderCurrent: (hint: AIHint) => ReactNode;
  renderPrevious: (hint: AIHint) => ReactNode;
}) {
  // `items` is newest-first, so the head is the answer to the question being
  // asked right now; older answers are collapsed so a new question swaps the
  // visible card instead of stacking stale answers on top of each other.
  const [current, ...previous] = items;
  const recentPrevious = previous.slice(0, 4);
  return (
    <div className="space-y-3">
      {renderCurrent(current)}
      {recentPrevious.length > 0 && (
        <details className="group rounded-md border border-dashed">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            Previous answers ({recentPrevious.length})
          </summary>
          <ul className="space-y-3 p-3 pt-0 opacity-80">{recentPrevious.map(renderPrevious)}</ul>
        </details>
      )}
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold">{title}</h3>
      <span className="text-xs text-muted-foreground">{count}</span>
    </div>
  );
}

function QuestionBankItem({
  hint,
  asked,
  onToggleAsked,
}: {
  hint: AIHint;
  asked: boolean;
  onToggleAsked: (id: string) => void;
}) {
  const parsed = parseQuestionBankHint(hint.content);
  if (!parsed) return null;
  return (
    <li className={`flex gap-3 rounded-md border bg-card/50 p-3 text-sm ${asked ? "opacity-60" : ""}`}>
      <MessagesSquare className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
      <div className="flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={difficultyTone(parsed.difficulty)}>{parsed.difficulty}</Badge>
        </div>
        <p className={`leading-relaxed ${asked ? "line-through" : ""}`}>{parsed.question}</p>
        <button
          type="button"
          onClick={() => onToggleAsked(hint.id)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {asked ? "Mark not asked" : "Mark asked"}
        </button>
      </div>
    </li>
  );
}

function RubricItem({
  hint,
  mode,
  current = false,
}: {
  hint: AIHint;
  mode: "interviewer" | "interviewee";
  current?: boolean;
}) {
  const rubric = parseRubricHint(hint.content);
  if (!rubric) return null;
  return (
    <li
      className={`space-y-2 rounded-md border p-3 text-sm ${
        current ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20" : "border-primary/20 bg-primary/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">{mode === "interviewer" ? "rubric" : "answer guide"}</Badge>
        {current && <Badge tone="success">current question</Badge>}
        <span className="text-xs text-muted-foreground">
          {mode === "interviewer" ? "private expected answer" : "private practice only"}
        </span>
      </div>
      <p className="font-medium leading-relaxed">{rubric.question}</p>
      <div className="whitespace-pre-line leading-relaxed text-muted-foreground">{rubric.body}</div>
    </li>
  );
}

function AnswerItem({ hint, current = false }: { hint: AIHint; current?: boolean }) {
  const answer = parseAnswerHint(hint.content);
  if (!answer) return null;
  return (
    <li
      className={`space-y-2 rounded-md border p-3 text-sm ${
        current
          ? "border-emerald-500/50 bg-emerald-500/10 ring-1 ring-emerald-500/25"
          : "border-emerald-500/25 bg-emerald-500/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">say this</Badge>
        {current && <span className="text-xs font-medium text-emerald-600">current question</span>}
        <span className="text-xs text-muted-foreground">private to you</span>
      </div>
      <p className="text-xs font-medium text-muted-foreground">{answer.question}</p>
      <p className="whitespace-pre-line leading-relaxed">{answer.answer}</p>
      {answer.keyPoints.length > 0 && (
        <div className="space-y-1 border-t border-emerald-500/20 pt-2">
          <p className="text-xs font-semibold text-muted-foreground">Be sure to mention</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {answer.keyPoints.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function RuntimeHintItem({ hint }: { hint: AIHint }) {
  const Icon = ICON_BY_KIND[hint.kind] ?? Lightbulb;
  return (
    <li className="flex gap-3 rounded-md border bg-card/50 p-3 text-sm">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <Badge tone={TONE_BY_KIND[hint.kind] ?? "default"}>
          {hint.kind.replace(/_/g, " ")}
        </Badge>
        <p className="leading-relaxed">{hint.content}</p>
      </div>
    </li>
  );
}

function parseQuestionBankHint(content: string):
  | { difficulty: "Easy" | "Medium" | "Hard"; skill: string; question: string }
  | null {
  const match = content.match(/^\[(Easy|Medium|Hard)\]\s+\[([^\]]+)\]\s+Ask:\s+(.+)$/);
  if (!match) return null;
  return {
    difficulty: match[1] as "Easy" | "Medium" | "Hard",
    skill: match[2],
    question: match[3],
  };
}

function difficultyTone(difficulty: "Easy" | "Medium" | "Hard") {
  if (difficulty === "Easy") return "success" as const;
  if (difficulty === "Medium") return "warning" as const;
  return "danger" as const;
}

function categoryTone(category: string) {
  // Highlight depth/logic questions — the ones that actually test understanding.
  return /depth|logic/i.test(category) ? ("warning" as const) : ("default" as const);
}

function parseAnswerHint(
  content: string,
): { question: string; answer: string; keyPoints: string[] } | null {
  if (!content.startsWith("[Answer]")) return null;
  const lines = content.split("\n").slice(1);
  const questionLine = lines.find((line) => line.startsWith("Question:"));
  const question = questionLine?.replace(/^Question:\s*/, "").trim() || "Detected question";

  const keyPointsLine = lines.find((line) => line.startsWith("Key points:"));
  const keyPoints = keyPointsLine
    ? keyPointsLine
        .replace(/^Key points:\s*/, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const answer = lines
    .filter((line) => !line.startsWith("Question:") && !line.startsWith("Key points:"))
    .join("\n")
    .trim();

  return { question, answer, keyPoints };
}

function parseRubricHint(content: string): { question: string; body: string } | null {
  if (!content.startsWith("[Rubric]")) return null;
  const lines = content.split("\n").slice(1);
  const questionLine = lines.find((line) => line.startsWith("Question:"));
  const question = questionLine?.replace(/^Question:\s*/, "").trim() || "Detected interviewer question";
  const body = lines
    .filter((line) => !line.startsWith("Question:"))
    .join("\n")
    .trim();
  return { question, body };
}
