import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { api, type ReportDetail } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CopyReportButton, GenerateReportButton } from "@/components/report-actions";
import {
  RECOMMENDATION_LABELS,
  formatScore,
  recommendationTone,
} from "@/lib/report-format";

export const dynamic = "force-dynamic";

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  let detail: ReportDetail | null = null;
  let error: string | null = null;
  try {
    detail = await api.getReport(sessionId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-6">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to reports
      </Link>

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            Could not load this report: {error}. Make sure the FastAPI server is running.
          </CardContent>
        </Card>
      )}

      {!error && detail && <ReportBody detail={detail} />}
    </div>
  );
}

function ReportBody({ detail }: { detail: ReportDetail }) {
  const r = detail.report;
  const candidate = detail.candidate_name ?? "Unnamed candidate";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{candidate}</h1>
          <p className="text-sm text-muted-foreground">
            Interviewed {new Date(detail.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r && <CopyReportButton detail={detail} />}
          <Link
            href={`/interview/live?sessionId=${detail.session_id}`}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Reopen live view
          </Link>
        </div>
      </div>

      {!r ? (
        <Card>
          <CardContent className="space-y-4 py-6 text-sm">
            <p className="text-muted-foreground">
              No final report has been generated for this interview yet.
            </p>
            <GenerateReportButton
              sessionId={detail.session_id}
              candidateName={detail.candidate_name}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Headline: recommendation + scores */}
          <Card>
            <CardContent className="flex flex-col gap-6 py-6 lg:flex-row lg:items-center">
              <div className="flex flex-col items-center justify-center rounded-lg bg-muted px-6 py-4 text-center lg:w-44">
                <div className="text-4xl font-bold tabular-nums">
                  {r.overall_score.toFixed(1)}
                  <span className="text-lg font-medium text-muted-foreground">/10</span>
                </div>
                <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Overall
                </div>
                <Badge className="mt-3" tone={recommendationTone(r.recommendation)}>
                  {RECOMMENDATION_LABELS[r.recommendation]}
                </Badge>
              </div>
              <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
                <ScoreStat label="Technical" value={r.technical_score} />
                <ScoreStat label="Communication" value={r.communication_score} />
                <ScoreStat label="Culture fit" value={r.culture_fit_score} />
              </div>
            </CardContent>
          </Card>

          <Section title="Summary">
            <p className="whitespace-pre-line leading-relaxed text-foreground/90">{r.summary}</p>
          </Section>

          <div className="grid gap-4 lg:grid-cols-3">
            <AnalysisCard
              title="Technical"
              score={r.technical_score}
              body={r.technical_analysis}
            />
            <AnalysisCard
              title="Communication"
              score={r.communication_score}
              body={r.communication_analysis}
            />
            <AnalysisCard
              title="Culture fit"
              score={r.culture_fit_score}
              body={r.culture_analysis}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <BulletCard title="Strengths" tone="success" items={r.strengths} emptyLabel="None noted." />
            <BulletCard
              title="Areas of concern"
              tone="danger"
              items={r.weaknesses}
              emptyLabel="None noted."
            />
          </div>

          {r.recommendation_rationale.trim() && (
            <Section title="Recommendation rationale">
              <p className="whitespace-pre-line leading-relaxed text-foreground/90">
                {r.recommendation_rationale}
              </p>
            </Section>
          )}

          {detail.job_description?.trim() && (
            <Section title="Role / job description">
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {detail.job_description}
              </p>
            </Section>
          )}
        </>
      )}
    </>
  );
}

function ScoreStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-4 text-center">
      <div className="text-2xl font-semibold tabular-nums">
        {value.toFixed(1)}
        <span className="text-sm font-normal text-muted-foreground">/10</span>
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

function AnalysisCard({ title, score, body }: { title: string; score: number; body: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <span className="text-sm font-semibold tabular-nums text-muted-foreground">
            {formatScore(score)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="text-sm leading-relaxed text-foreground/90">
        {body.trim() ? (
          <p className="whitespace-pre-line">{body}</p>
        ) : (
          <p className="text-muted-foreground">No analysis available.</p>
        )}
      </CardContent>
    </Card>
  );
}

function BulletCard({
  title,
  tone,
  items,
  emptyLabel,
}: {
  title: string;
  tone: "success" | "danger";
  items: string[];
  emptyLabel: string;
}) {
  const dot = tone === "success" ? "bg-emerald-500" : "bg-destructive";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {items.length ? (
          <ul className="space-y-2">
            {items.map((item, i) => (
              <li key={i} className="flex gap-2 leading-relaxed">
                <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} aria-hidden />
                <span className="text-foreground/90">{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{emptyLabel}</p>
        )}
      </CardContent>
    </Card>
  );
}
