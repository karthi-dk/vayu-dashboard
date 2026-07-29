"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/utils";

type Props = {
  /**
   * ISO 8601 timestamp string. Recomputed relative label every 30s so
   * "just now" ages into "1m ago" → "2m ago" without needing a server
   * re-render. When null/undefined, renders "never".
   */
  isoDate: string | null | undefined;
  className?: string;
};

/**
 * Renders a relative-time label ("just now", "2m ago", "3h ago", "5d ago")
 * that ticks locally in the browser. Use this anywhere the parent is a
 * server component whose HTML gets baked at render time — otherwise the
 * label stays frozen and misleads the user.
 *
 * Tick interval is 30s: fine-grained enough for "just now → 1m" without
 * burning render cycles. Uses a state increment (not `Date.now()` directly)
 * so React only re-renders on the tick.
 *
 * The underlying isoDate itself does not refresh — that still requires
 * router.refresh() or a hard reload. This component only prevents display
 * from going STALE while the timestamp itself is still accurate.
 */
export function TimeAgo({ isoDate, className }: Props) {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!isoDate) return;
    const id = setInterval(() => forceRender((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [isoDate]);

  return <span className={className}>{timeAgo(isoDate)}</span>;
}
