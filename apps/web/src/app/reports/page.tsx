import Link from "next/link";
import { api, type ReportListItem } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeleteAllReportsButton, DeleteReportButton } from "@/components/report-actions";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  let reports: ReportListItem[] = [];
  let error: string | null = null;
  try {
    reports = await api.listReports();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interview reports</h1>
          <p className="text-sm text-muted-foreground">
            Past interview sessions and their final evaluation reports.
          </p>
        </div>
        {!error && reports.length > 0 && <DeleteAllReportsButton count={reports.length} />}
      </div>

      {error && (
        <Card className="animate-card-in">
          <CardContent className="text-sm text-destructive">
            Could not load reports: {error}. Make sure the FastAPI server is running.
          </CardContent>
        </Card>
      )}

      {!error && reports.length === 0 && (
        <Card className="animate-card-in">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No interviews yet. Start one from the Chrome extension side panel.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {reports.map((row) => (
          <Card
            key={row.session_id}
            className="animate-card-in transition hover:-translate-y-1 hover:border-primary/30 hover:shadow-xl"
          >
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="min-w-0 truncate">
                  {row.candidate_name ?? "Unnamed candidate"}
                </CardTitle>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <DeleteReportButton
                    sessionId={row.session_id}
                    candidateName={row.candidate_name}
                  />
                </div>
              </div>
              <CardDescription>
                Started {new Date(row.created_at).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {row.report ? (
                <>
                  <p className="text-muted-foreground">{row.report.summary}</p>
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <ScorePill label="Overall" value={row.report.overall_score} />
                    <ScorePill label="Tech" value={row.report.technical_score} />
                    <ScorePill label="Comm" value={row.report.communication_score} />
                    <ScorePill label="Culture" value={row.report.culture_fit_score} />
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">No final report yet.</p>
              )}
              <Link
                href={`/interview/live?sessionId=${row.session_id}`}
                className="inline-block rounded text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Reopen live view →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ScorePill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted px-2 py-1 text-center">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="font-semibold">{value.toFixed(1)}</div>
    </div>
  );
}

function statusTone(status: string) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "active") return "warning" as const;
  return "default" as const;
}
