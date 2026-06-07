"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/interview/live", label: "Live" },
  { href: "/reports", label: "Reports" },
] as const;

export function MainNav() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="container flex h-14 items-center justify-between">
      <Link href="/" className="font-semibold transition hover:text-primary">
        AI Interview Co-Pilot
      </Link>
      <div className="flex items-center gap-1 text-sm">
        {LINKS.map((link) => {
          const active = isActive(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative rounded-md px-3 py-1.5 font-medium transition-colors",
                active
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              {link.label}
              {active && (
                <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
