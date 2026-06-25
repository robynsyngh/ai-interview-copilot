import type { RecommendationValue, ReportDetail, ReportSummary } from "@/lib/api";

export const RECOMMENDATION_LABELS: Record<RecommendationValue, string> = {
  strong_hire: "Strong Hire",
  hire: "Hire",
  no_hire: "No Hire",
  strong_no_hire: "Strong No Hire",
};

export type BadgeTone = "default" | "success" | "warning" | "danger";

export function recommendationTone(rec: RecommendationValue): BadgeTone {
  switch (rec) {
    case "strong_hire":
    case "hire":
      return "success";
    case "no_hire":
      return "warning";
    case "strong_no_hire":
      return "danger";
    default:
      return "default";
  }
}

/** Scores are stored on a 0-10 scale. Always present them as "X.X / 10". */
export function formatScore(value: number): string {
  return `${value.toFixed(1)} / 10`;
}

/** Plain-text rendering of a report, suitable to paste into an email to HR. */
export function buildReportText(detail: ReportDetail): string {
  const r = detail.report;
  const lines: string[] = [];
  const candidate = detail.candidate_name ?? "Unnamed candidate";
  const date = new Date(detail.created_at).toLocaleString();

  lines.push("INTERVIEW EVALUATION REPORT");
  lines.push("=".repeat(40));
  lines.push(`Candidate: ${candidate}`);
  lines.push(`Interview date: ${date}`);

  if (!r) {
    lines.push("");
    lines.push("No final report has been generated for this interview yet.");
    return lines.join("\n");
  }

  lines.push(`Recommendation: ${RECOMMENDATION_LABELS[r.recommendation]}`);
  lines.push("");
  lines.push("SCORES (out of 10)");
  lines.push("-".repeat(40));
  lines.push(`Overall:        ${r.overall_score.toFixed(1)} / 10`);
  lines.push(`Technical:      ${r.technical_score.toFixed(1)} / 10`);
  lines.push(`Communication:  ${r.communication_score.toFixed(1)} / 10`);
  lines.push(`Culture fit:    ${r.culture_fit_score.toFixed(1)} / 10`);

  lines.push("");
  lines.push("SUMMARY");
  lines.push("-".repeat(40));
  lines.push(r.summary || "—");

  const section = (title: string, body: string) => {
    if (!body.trim()) return;
    lines.push("");
    lines.push(title);
    lines.push("-".repeat(40));
    lines.push(body.trim());
  };

  section("TECHNICAL ASSESSMENT", r.technical_analysis);
  section("COMMUNICATION ASSESSMENT", r.communication_analysis);
  section("CULTURE FIT ASSESSMENT", r.culture_analysis);

  const bullets = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push("");
    lines.push(title);
    lines.push("-".repeat(40));
    for (const item of items) lines.push(`• ${item}`);
  };

  bullets("STRENGTHS", r.strengths);
  bullets("AREAS OF CONCERN", r.weaknesses);

  if (r.recommendation_rationale.trim()) {
    lines.push("");
    lines.push("RECOMMENDATION RATIONALE");
    lines.push("-".repeat(40));
    lines.push(r.recommendation_rationale.trim());
  }

  if (detail.job_description?.trim()) {
    lines.push("");
    lines.push("ROLE / JOB DESCRIPTION");
    lines.push("-".repeat(40));
    lines.push(detail.job_description.trim());
  }

  return lines.join("\n");
}

export type { ReportSummary };
