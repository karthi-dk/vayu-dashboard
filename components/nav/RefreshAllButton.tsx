"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, X, Loader2 } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Compact refresh button in the top navigation bar
 * ================================================
 *
 * One click triggers MF NAVs, NPS NAVs, AND the index-highs (ATH/52w/3m)
 * snapshot refresh, all three in parallel. Same underlying API calls as
 * the RefreshNavsCard on the Sync page — this is just the "always-
 * visible, one-click, simple status" version for users who don't want
 * to navigate to Sync.
 *
 * Index-highs was folded in on 2026-07-24 after a staleness bug (Yahoo's
 * chart endpoint serving null/stale closes — see yahooClient.ts) made
 * clear that a THIRD separate button most people would never find was
 * the wrong shape. It's still cheap (one more fetch in the same
 * Promise.all) and idempotent (index_levels is a snapshot table, not a
 * time series — see migrations/2026-07-23-index-levels.sql), so there's
 * no reason not to always refresh it alongside NAVs.
 *
 * DESIGN CHOICES
 * --------------
 * • Icon-only in TopNav so it doesn't compete visually with the
 *   "Last sync X" indicator or the theme toggle. Full status still
 *   available on hover via the title attribute.
 * • Uses Promise.allSettled so one endpoint's failure doesn't block
 *   the other's write. Half-success (MF ok, NPS failed) is a real
 *   state we surface as "partial refresh · X failed".
 * • Auto-resets to idle 3s after settling — this is a "fire and
 *   forget" affordance, not a persistent status. Persistent state
 *   lives on the Sync page card.
 * • Calls router.refresh() after settling so every server component
 *   re-fetches (Overview cards, headline, everything).
 *
 * WHY NOT A TOAST LIBRARY
 * -----------------------
 * We don't have one wired in yet and a full-fat toast lib is overkill
 * for one button's status. The 3-second in-place icon+color swap
 * covers the "did it work" question without adding another dependency.
 * If we ever add multiple parallel refresh flows (e.g., Dhan
 * batch-sync from other pages), we'll graduate to a real toast system.
 */

type Status = "idle" | "loading" | "success" | "partial" | "error";

// Shape of the /api/refresh-mf-nav success payload — just what the
// tooltip needs. See app/api/refresh-mf-nav/route.ts for the full
// response contract.
type MfBody = {
  ok: boolean;
  nav_date?: string | null;
  counts?: {
    rotated: number;
    already_fresh: number;
    skipped_stale: number;
    failed: number;
    total: number;
  };
  message?: string;
  error?: string;
};

type NpsBody = {
  ok: boolean;
  nav_date?: string | null;
  already_fresh?: boolean;
  skipped_stale?: boolean;
  first_refresh?: boolean;
  nps_1d_change_inr?: number;
  nps_1d_change_pct?: number;
  message?: string;
  error?: string;
};

// Shape of the /api/refresh-index-levels success payload — see
// app/api/refresh-index-levels/route.ts for the full response contract.
type IndexBody = {
  ok: boolean;
  refreshed?: number;
  failed?: number;
  total?: number;
  message?: string;
  error?: string;
};

/**
 * Structured summary of one refresh run. Kept as a stateful record
 * (not just a message string) so the tooltip can render a rich
 * multi-line layout with per-source icons and colors, and so the
 * `Last refreshed X ago` line accurately reflects when the button
 * last fired regardless of the current button icon state.
 */
type RunSummary = {
  mf:
    | { kind: "ok"; action: string; navDate: string | null }
    | { kind: "error"; reason: string };
  nps:
    | { kind: "ok"; action: string; navDate: string | null }
    | { kind: "error"; reason: string };
  index:
    | { kind: "ok"; action: string; navDate: string | null }
    | { kind: "error"; reason: string };
  ranAt: number; // epoch ms — powers "just now" / "3s ago" in the tooltip
};

export function RefreshAllButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  // Track the last settle so an in-flight second click doesn't reset
  // the timer prematurely. Fire-and-forget with cleanup on unmount.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function refresh() {
    if (status === "loading") return;

    setStatus("loading");
    if (resetTimer.current) clearTimeout(resetTimer.current);

    // Parse into { ok, body } shape so we can tell apart:
    //   (a) network/HTTP failure — Promise.allSettled catches
    //   (b) endpoint replied 200 but ok=false — body.ok tells us
    const parse = async <T,>(
      p: Promise<Response>
    ): Promise<{ ok: true; body: T } | { ok: false; error: string }> => {
      try {
        const res = await p;
        const body = (await res.json()) as T & {
          ok: boolean;
          error?: string;
        };
        if (!res.ok || !body.ok) {
          return { ok: false, error: body.error || `HTTP ${res.status}` };
        }
        return { ok: true, body };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const [mf, nps, index] = await Promise.all([
      parse<MfBody>(fetch("/api/refresh-mf-nav", { method: "POST" })),
      parse<NpsBody>(fetch("/api/refresh-nps-nav", { method: "POST" })),
      parse<IndexBody>(fetch("/api/refresh-index-levels", { method: "POST" })),
    ]);

    // Compose per-source result records so the tooltip can render each
    // side independently. Kept as structured data (not pre-formatted
    // strings) so the tooltip layout can pick colors / icons per
    // branch without re-parsing a message.
    const mfResult: RunSummary["mf"] = mf.ok
      ? {
          kind: "ok",
          action: summarizeMf(mf.body),
          navDate: mf.body.nav_date ?? null,
        }
      : { kind: "error", reason: mf.error };

    const npsResult: RunSummary["nps"] = nps.ok
      ? {
          kind: "ok",
          action: summarizeNps(nps.body),
          navDate: nps.body.nav_date ?? null,
        }
      : { kind: "error", reason: nps.error };

    const indexResult: RunSummary["index"] = index.ok
      ? {
          kind: "ok",
          action: summarizeIndex(index.body),
          navDate: null, // index_levels is a snapshot, not dated like a NAV
        }
      : { kind: "error", reason: index.error };

    setSummary({ mf: mfResult, nps: npsResult, index: indexResult, ranAt: Date.now() });

    // Icon color reflects the worst-branch outcome — error > partial > success.
    const errorCount = [mfResult, npsResult, indexResult].filter(
      (r) => r.kind === "error"
    ).length;
    if (errorCount === 3) {
      setStatus("error");
    } else if (errorCount > 0) {
      setStatus("partial");
    } else {
      // All three top-level calls OK — check if MF or index had any
      // per-item failures (both endpoints return ok=true even when some
      // per-fund/per-index updates fail, so we have to peek at counts
      // here to distinguish "all fresh" from "all failed").
      const mfHasPerFundFailures =
        mf.ok && (mf.body.counts?.failed ?? 0) > 0;
      const mfAllFailed =
        mf.ok && (mf.body.counts?.failed ?? 0) === (mf.body.counts?.total ?? 0);
      const indexHasPerIndexFailures = index.ok && (index.body.failed ?? 0) > 0;
      const indexAllFailed =
        index.ok && (index.body.failed ?? 0) === (index.body.total ?? 0);
      if (mfAllFailed || indexAllFailed) setStatus("error");
      else if (mfHasPerFundFailures || indexHasPerIndexFailures) setStatus("partial");
      else setStatus("success");
    }

    // Ensure every server component re-fetches — headline card, MF
    // card, sync page, everything reads the fresh DB values on the
    // next render. This is what makes the "check the number update"
    // UX feel synchronous.
    router.refresh();

    // Reset icon visual to idle after 3s. The `summary` state persists
    // (so hover after the icon resets still shows the last run's
    // outcome) but the button glyph goes back to a neutral refresh.
    resetTimer.current = setTimeout(() => {
      setStatus("idle");
    }, 3000);
  }

  const Icon =
    status === "loading"
      ? Loader2
      : status === "success"
        ? Check
        : status === "partial"
          ? RefreshCw
          : status === "error"
            ? X
            : RefreshCw;

  const iconClass =
    status === "loading"
      ? "animate-spin"
      : status === "success"
        ? "text-[hsl(var(--success))]"
        : status === "partial"
          ? "text-[hsl(var(--warning))]"
          : status === "error"
            ? "text-[hsl(var(--danger))]"
            : "";

  return (
    <Tooltip
      content={<TooltipBody status={status} summary={summary} />}
      side="bottom"
      align="end"
    >
      <button
        onClick={refresh}
        disabled={status === "loading"}
        aria-label={
          status === "loading"
            ? "Refreshing NAVs"
            : "Refresh MF and NPS NAVs"
        }
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Icon size={14} className={iconClass} />
      </button>
    </Tooltip>
  );
}

// ── Tooltip body ──────────────────────────────────────────────────────

/**
 * Multi-line tooltip content. Three modes:
 *   • idle + no prior run  → 2-line instruction ("Click to refresh…")
 *   • loading              → single "Fetching…" line
 *   • idle / success / etc. with a prior run  → structured summary
 *
 * Rendered inside the custom Tooltip component which fades in in 75ms
 * (vs the browser native title's ~800ms), so a quick hover reveals
 * this immediately. The tooltip stays visible as long as the cursor
 * is over the button.
 */
function TooltipBody({
  status,
  summary,
}: {
  status: Status;
  summary: RunSummary | null;
}) {
  if (status === "loading") {
    return <div className="min-w-[180px]">Fetching latest NAVs…</div>;
  }

  if (!summary) {
    return (
      <div className="min-w-[180px] space-y-0.5">
        <div className="font-medium">Refresh NAVs</div>
        <div className="opacity-70">MF · NPS · Index highs (ATH/52w/3m)</div>
      </div>
    );
  }

  return (
    <div className="min-w-[200px] space-y-1.5">
      <SummaryRow label="MF" branch={summary.mf} />
      <SummaryRow label="NPS" branch={summary.nps} />
      <SummaryRow label="Index highs" branch={summary.index} />
    </div>
  );
}

function SummaryRow({
  label,
  branch,
}: {
  label: string;
  branch: RunSummary["mf"] | RunSummary["index"];
}) {
  // Small dot color-coded per branch so scanning is instant — green
  // means source succeeded, red means it failed. Deliberately drawn
  // in the tooltip's inverse color scheme (foreground bg / background
  // text) since it lives inside the tooltip surface.
  const dotColor =
    branch.kind === "ok"
      ? "hsl(var(--success))"
      : "hsl(var(--danger))";

  return (
    <div className="flex items-baseline gap-2">
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: dotColor }}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="opacity-80">
          {branch.kind === "ok" ? branch.action : `Failed · ${branch.reason}`}
        </div>
      </div>
    </div>
  );
}

// ── Summarizers ───────────────────────────────────────────────────────

/**
 * Turn the MF refresh response into a one-line action description for
 * the tooltip. Prefers concrete numbers ("Refreshed 3 · 7 already
 * fresh") over vague verbs ("Refreshed"), so a scan tells you exactly
 * what changed.
 */
function summarizeMf(body: MfBody): string {
  const c = body.counts;
  if (!c) return body.message ?? "Refreshed";
  const parts: string[] = [];
  if (c.rotated > 0) parts.push(`Refreshed ${c.rotated}`);
  if (c.already_fresh > 0) parts.push(`${c.already_fresh} already fresh`);
  if (c.skipped_stale > 0) parts.push(`${c.skipped_stale} skipped stale`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  const line = parts.length > 0 ? parts.join(" · ") : "No funds";
  return body.nav_date ? `${line} · as of ${formatDate(body.nav_date)}` : line;
}

/**
 * NPS refresh — the response is a discriminated shape (already_fresh,
 * skipped_stale, first_refresh, or "rotated" implied by absence of
 * those flags). Convert to a natural sentence.
 */
function summarizeNps(body: NpsBody): string {
  const dateSuffix = body.nav_date
    ? ` · as of ${formatDate(body.nav_date)}`
    : "";
  if (body.already_fresh) return `Already up to date${dateSuffix}`;
  if (body.skipped_stale) return `Kotak stale — kept DB value${dateSuffix}`;
  if (body.first_refresh) return `First refresh${dateSuffix}`;
  const oneDay = body.nps_1d_change_inr;
  if (typeof oneDay === "number") {
    const sign = oneDay >= 0 ? "+" : "";
    return `Refreshed · ${sign}₹${Math.round(oneDay).toLocaleString("en-IN")} 1D${dateSuffix}`;
  }
  return `Refreshed${dateSuffix}`;
}

/**
 * Index-highs refresh — the response is a flat refreshed/failed/total
 * count (see app/api/refresh-index-levels/route.ts), simpler than the
 * MF/NPS discriminated shapes since there's only one outcome axis (how
 * many of the 6 tracked indices succeeded).
 */
function summarizeIndex(body: IndexBody): string {
  const total = body.total ?? 0;
  const refreshed = body.refreshed ?? 0;
  const failed = body.failed ?? 0;
  if (total === 0) return body.message ?? "Refreshed";
  if (failed === 0) return `${refreshed}/${total} indices refreshed`;
  return `${refreshed}/${total} refreshed · ${failed} failed`;
}

/**
 * Format an ISO date (YYYY-MM-DD) as "Jul 16" — matches the format the
 * Sync page mini-panels use so the two indicators feel like the same
 * system.
 */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[m - 1]} ${d}`;
}
