"use client";

import { useEffect, useMemo, useRef } from "react";
import type { TranscriptSegment } from "@copilot/shared";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  segments: TranscriptSegment[];
}

export function TranscriptPane({ segments }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Newest-first (LIFO) to stay consistent with the AI assist and question-bank
  // columns: the most recent line sits at the top of every column.
  const finalSegments = useMemo(
    () =>
      segments
        .filter((segment) => segment.is_final)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [segments],
  );
  const livePartial = useMemo(
    () => [...segments].reverse().find((segment) => !segment.is_final),
    [segments],
  );

  useEffect(() => {
    const node = scrollerRef.current;
    if (node) {
      node.scrollTop = 0;
    }
  }, [segments]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>Live transcript</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div ref={scrollerRef} className="h-full overflow-y-auto px-6 pb-6">
          {segments.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Waiting for audio from the captured tab…
            </p>
          ) : (
            <div className="space-y-4">
              {livePartial && (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">
                    Hearing now
                  </div>
                  <p className="italic leading-relaxed text-muted-foreground">
                    {livePartial.text}
                  </p>
                </div>
              )}

              {finalSegments.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Listening… final transcript lines will appear here.
                </p>
              ) : (
                <ul className="space-y-3">
                  {finalSegments.map((segment) => (
                    <li
                      key={segment.id}
                      className={cn(
                        "rounded-md px-3 py-2 text-sm leading-relaxed",
                        segment.speaker === "candidate" && "bg-primary/5",
                        segment.speaker === "interviewer" && "bg-accent",
                        segment.speaker === "unknown" && "bg-muted",
                      )}
                    >
                      <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {speakerLabel(segment.speaker)}
                      </span>
                      {segment.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function speakerLabel(speaker: TranscriptSegment["speaker"]): string {
  if (speaker === "unknown") return "audio";
  return speaker;
}
