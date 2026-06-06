import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LandingPage() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">AI Interview Co-Pilot</h1>
        <p className="max-w-2xl text-muted-foreground">
          Pair the Chrome extension with your meeting tab to capture audio, stream it to Deepgram for
          live transcription, and let GitHub Models propose follow-up questions in real time. Your
          dashboard shows transcripts, hints, and a final report.
        </p>
        <div className="flex gap-3">
          <Link
            href="/interview/live"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open live dashboard
          </Link>
          <Link
            href="/reports"
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-transparent px-4 text-sm font-medium hover:bg-accent"
          >
            View past reports
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>1. Capture audio</CardTitle>
            <CardDescription>
              The Chrome extension uses the Offscreen API to capture meeting audio.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Streams binary chunks over WebSocket to <code>/api/live-stream</code>.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>2. Transcribe + evaluate</CardTitle>
            <CardDescription>
              FastAPI fans audio into Deepgram Nova-2 and feeds transcripts to GitHub Models.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            All transcripts and hints persist to PostgreSQL.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>3. Render live</CardTitle>
            <CardDescription>
              The Next.js dashboard subscribes to a live-feed WebSocket and renders updates.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            On finalize, a structured report is committed to the DB.
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
