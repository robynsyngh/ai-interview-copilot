import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Interview Co-Pilot",
  description: "Real-time interviewing assistance powered by Deepgram + GitHub Models.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <header className="border-b">
          <nav className="container flex h-14 items-center justify-between">
            <Link href="/" className="font-semibold">
              AI Interview Co-Pilot
            </Link>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/interview/live" className="hover:text-foreground">
                Live
              </Link>
              <Link href="/reports" className="hover:text-foreground">
                Reports
              </Link>
            </div>
          </nav>
        </header>
        <main className="container py-8">{children}</main>
      </body>
    </html>
  );
}
