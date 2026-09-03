"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icon-only refresh for the Index highs card. POSTs the index-levels
 * refresh (forces a fresh Yahoo pull regardless of the 60 s auto-refresh
 * staleness gate), then soft-refreshes the route so the card shows the
 * new numbers in place — no full page reload. `useTransition` keeps the
 * icon spinning through both the fetch and the server re-render.
 */
export function RefreshIndexLevelsButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(false);

  const busy = fetching || isPending;

  async function refresh() {
    if (busy) return;
    setFetching(true);
    setError(false);
    try {
      const resp = await fetch("/api/refresh-index-levels", { method: "POST" });
      const body = await resp.json();
      if (!resp.ok || !body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
      startTransition(() => router.refresh());
    } catch {
      setError(true);
    } finally {
      setFetching(false);
    }
  }

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={busy}
      aria-label="Refresh index highs"
      title={
        error
          ? "Refresh failed — click to retry"
          : "Refresh index highs — pull the latest from Yahoo"
      }
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70",
        error &&
          "border-[hsl(var(--danger)/0.4)] text-[hsl(var(--danger))] hover:text-[hsl(var(--danger))]"
      )}
    >
      <RefreshCw size={13} className={cn(busy && "animate-spin")} />
    </button>
  );
}
