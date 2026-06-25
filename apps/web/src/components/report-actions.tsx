"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Sparkles, Trash2 } from "lucide-react";
import { api, type ReportDetail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { buildReportText } from "@/lib/report-format";

export function CopyReportButton({ detail }: { detail: ReportDetail }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    const text = buildReportText(detail);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({
        title: "Report copied",
        description: "Paste it into an email or message to forward to HR.",
        tone: "success",
      });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Could not copy",
        description: "Your browser blocked clipboard access. Select and copy manually.",
        tone: "error",
      });
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
      {copied ? (
        <Check className="mr-1.5 h-4 w-4" aria-hidden />
      ) : (
        <Copy className="mr-1.5 h-4 w-4" aria-hidden />
      )}
      {copied ? "Copied" : "Copy report for HR"}
    </Button>
  );
}

export function GenerateReportButton({
  sessionId,
  candidateName,
}: {
  sessionId: string;
  candidateName: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleGenerate = async () => {
    setError(null);
    setIsGenerating(true);
    try {
      await api.finalize(sessionId);
      const label = candidateName ? `"${candidateName}"` : "this interview";
      toast({
        title: "Report generated",
        description: `The final evaluation for ${label} is ready.`,
        tone: "success",
      });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Could not generate report", description: message, tone: "error" });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        onClick={() => void handleGenerate()}
        disabled={isPending}
        loading={isGenerating}
        loadingLabel="Generating…"
      >
        <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
        Generate report
      </Button>
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </div>
  );
}

export function DeleteReportButton({
  sessionId,
  candidateName,
}: {
  sessionId: string;
  candidateName: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleDelete = async () => {
    const label = candidateName ? `"${candidateName}"` : "this interview";
    if (!window.confirm(`Delete ${label} and all of its data? This cannot be undone.`)) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      await api.deleteReport(sessionId);
      toast({ title: "Interview deleted", description: "The session and report were removed.", tone: "success" });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Could not delete interview", description: message, tone: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleDelete()}
        disabled={isPending}
        loading={isDeleting}
        loadingLabel="Deleting…"
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
        Delete
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

export function DeleteAllReportsButton({ count }: { count: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleDeleteAll = async () => {
    if (
      !window.confirm(
        `Delete ALL ${count} interview${count === 1 ? "" : "s"} and every associated report? This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    setIsDeleting(true);
    try {
      const result = await api.deleteAllReports();
      toast({
        title: "All reports deleted",
        description: `${result.deleted} interview${result.deleted === 1 ? "" : "s"} removed.`,
        tone: "success",
      });
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Could not delete reports", description: message, tone: "error" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="destructive"
        size="sm"
        onClick={() => void handleDeleteAll()}
        disabled={isPending || count === 0}
        loading={isDeleting}
        loadingLabel="Deleting…"
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
        Delete all
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
