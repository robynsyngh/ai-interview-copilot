import type { Metadata } from "next";
import { MainNav } from "@/components/main-nav";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Interview Co-Pilot",
  description: "Real-time interviewing assistance powered by Deepgram + GitHub Models.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ToastProvider>
          <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
            <MainNav />
          </header>
          <main className="container animate-page-in py-8">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
