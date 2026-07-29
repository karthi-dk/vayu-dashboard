"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  // Studio sits FIRST because it's the daily recording landing surface
  // for the 10K→100Cr experiment videos — opening the PWA drops the
  // user here to log yesterday's allotment, watch the reveal
  // animation, and record the shot. High-frequency (once/day, every
  // day) and time-critical (needs to be first thing after PWA cold
  // start), so it earns leftmost placement over the analytical
  // Overview tab that used to be there.
  { href: "/studio", label: "Studio" },
  { href: "/", label: "Overview" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/credits", label: "Credits" },
  { href: "/sync", label: "Sync" },
  { href: "/settings", label: "Settings" },
  // Filings lives at the far right of the nav — it's a once-a-year
  // analytical view (tax filings), consulted much less often than
  // the daily/weekly surfaces (Studio, Overview, Portfolio, Credits)
  // and the ingest/config surfaces (Sync, Settings). Placing it last
  // keeps the muscle-memory order of the frequently-used tabs intact.
  { href: "/filings", label: "Filings" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-3 sm:gap-6">
      {LINKS.map(({ href, label }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "text-sm font-medium transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
