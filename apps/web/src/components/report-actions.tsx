"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function DeleteReportButton({
  sessionId,
  candidateName,
}: {
  sessionId: string;
  candidateName: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleDelete = () => {
    const label = candidateName ? `"${candidateName}"` : "this interview";
    if (!window.confirm(`Delete ${label} and all of its data? This cannot be undone.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await api.deleteReport(sessionId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={isPending}
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
        {isPending ? "Deleting…" : "Delete"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

export function DeleteAllReportsButton({ count }: { count: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleDeleteAll = () => {
    if (
      !window.confirm(
        `Delete ALL ${count} interview${count === 1 ? "" : "s"} and every associated report? This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await api.deleteAllReports();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDeleteAll}
        disabled={isPending || count === 0}
      >
        <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
        {isPending ? "Deleting…" : "Delete all"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
