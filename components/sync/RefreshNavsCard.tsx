"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  FileCheck,
  Landmark,
  TrendingUp,
  LineChart,
  RefreshCw as RefreshCwIcon,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { fmtDateShort, fmtL } from "@/lib/utils";
import type { MfNavSource, NavSource, SyncData } from "@/lib/queries";

type Props = {
  mf: SyncData["mf"];
  nps: SyncData["nps"];
  indexLevels: SyncData["indexLevels"];
};

/**
 * Refresh NAVs card — unified MF + NPS in one place
 * ==================================================
 *
 * Replaces the standalone NpsRefreshCard with a single card that fires
 * both refreshes in parallel on one click. Rationale: both refreshes
 * always run together in daily cron anyway; showing them as two
 * separate cards was cognitive overhead for zero UX benefit. See
 * 2026-07-17 chat log for the design decision.
 *
 * Index highs (ATH/52w/3m) joined the party on 2026-07-24 — same
 * rationale, one more free-riding parallel fetch rather than a third
 * button most people would never think to click.
 *
 * LAYOUT
 * ------
 *   ┌── Refresh NAVs                              [Refresh] ──┐
 *   │  Mutual Funds · NPS · Index highs · latest prices        │
 *   │  ┌─ Mutual Funds ─┐ ┌─ NPS ──────┐ ┌─ Index highs ─┐      │
 *   │  │ ₹XX L · Nf     │ │ ₹YY L ·POP │ │ 6/6 refreshed │      │
 *   │  │ from mfapi.in  │ │ from CAMS  │ │ Xm ago        │      │
 *   │  │ NAVs Xd·Xm ago │ │ NAVs Yd    │ │               │      │
 *   │  └────────────────┘ └────────────┘ └───────────────┘      │
 *   │  ● Combined status line                                  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * PARTIAL SUCCESS HANDLING
 * ------------------------
 * Uses Promise.allSettled so one path failing doesn't block the
 * others. The status line composes a message across all three
 * results:
 *   • all ok        → "All up to date · Come back tomorrow morning"
 *   • all rotated   → "MF: -N₹ 1D · NPS: +M₹ 1D · Index highs refreshed"
 *   • one path fails → "MF refreshed · NPS failed (reason) · ..."
 *   • all fail      → "All sources failed — check network"
 *
 * Individual mini-panels retain their own PulseDot color reflecting
 * per-source status (green ok / amber fallback / red failed) so you
 * can spot which side is broken without reading the message.
 */
export function RefreshNavsCard({ mf, nps, indexLevels }: Props) {
  const router = useRouter();
  // "partial" is a distinct visual state for cases where the endpoints
  // succeeded (HTTP 200 ok=true) but per-fund outcomes show mixed
  // rotate/fail — e.g., "3 MF refreshed, 7 failed". Rendered in the
  // amber "warning" palette rather than green (success) or red
  // (error) so the user notices something needs attention without
  // being alarmed.
  const [state, setState] = useState<
    "idle" | "loading" | "success" | "partial" | "error"
  >("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [mfMessage, setMfMessage] = useState<string | null>(null);
  const [mfStatus, setMfStatus] = useState<"ok" | "partial" | "error" | null>(
    null
  );
  const [npsMessage, setNpsMessage] = useState<string | null>(null);
  const [npsStatus, setNpsStatus] = useState<"ok" | "error" | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<
    "ok" | "partial" | "error" | null
  >(null);
  const [indexUpdatedAt, setIndexUpdatedAt] = useState<string | null>(null);

  async function refresh() {
    setState("loading");
    setMessage(null);
    setMfMessage(null);
    setMfStatus(null);
    setNpsMessage(null);
    setNpsStatus(null);
    setFallbackReason(null);
    setIndexMessage(null);
    setIndexStatus(null);

    // All three requests fire concurrently. Promise.allSettled ensures
    // a failure on one doesn't abort the others' write paths server-side.
    const [mfRes, npsRes, indexRes] = await Promise.allSettled([
      fetch("/api/refresh-mf-nav", { method: "POST" }).then(async (r) => {
        const body = await r.json();
        if (!r.ok || !body.ok) {
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return body as {
          ok: true;
          nav_date: string | null;
          counts: {
            rotated: number;
            already_fresh: number;
            skipped_stale: number;
            failed: number;
            total: number;
          };
          message: string;
        };
      }),
      fetch("/api/refresh-nps-nav", { method: "POST" }).then(async (r) => {
        const body = await r.json();
        if (!r.ok || !body.ok) {
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return body as {
          ok: true;
          source?: string;
          kotak_fallback_reason?: string;
          nav_date?: string;
          already_fresh?: boolean;
          skipped_stale?: boolean;
          first_refresh?: boolean;
          nps_1d_change_inr?: number;
          message?: string;
        };
      }),
      fetch("/api/refresh-index-levels", { method: "POST" }).then(async (r) => {
        const body = await r.json();
        if (!r.ok || !body.ok) {
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return body as {
          ok: true;
          refreshed: number;
          failed: number;
          total: number;
          message: string;
        };
      }),
    ]);

    // ── MF branch ──
    if (mfRes.status === "fulfilled") {
      const m = mfRes.value;
      setMfMessage(m.message);
      // Status tri-state so the mini-panel dot color reflects the
      // actual outcome instead of string-matching the message:
      //   ok      — everything rotated or already fresh
      //   partial — some funds rotated, some failed
      //   error   — all funds failed (endpoint returned 200 but
      //             every per-fund update errored)
      if (m.counts.failed === m.counts.total) {
        setMfStatus("error");
      } else if (m.counts.failed > 0) {
        setMfStatus("partial");
      } else {
        setMfStatus("ok");
      }
    } else {
      setMfMessage(
        mfRes.reason instanceof Error ? mfRes.reason.message : String(mfRes.reason)
      );
      setMfStatus("error");
    }

    // ── NPS branch ──
    if (npsRes.status === "fulfilled") {
      const n = npsRes.value;
      setNpsStatus("ok");
      if (typeof n.kotak_fallback_reason === "string") {
        setFallbackReason(n.kotak_fallback_reason);
      }
      const srcLabel =
        n.source === "kotak"
          ? "Kotak"
          : n.source === "npsnav.in"
            ? "npsnav.in (fallback)"
            : "";
      const srcSuffix = srcLabel ? ` · from ${srcLabel}` : "";
      if (n.skipped_stale) {
        setNpsMessage(
          `Skipped · ${srcLabel} returned older data than DB. Retry tomorrow.`
        );
      } else if (n.already_fresh) {
        setNpsMessage(`Already up to date${srcSuffix}`);
      } else if (n.first_refresh) {
        setNpsMessage(`Baselined NAVs (${n.nav_date})${srcSuffix}`);
      } else {
        const delta = Number(n.nps_1d_change_inr ?? 0);
        const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
        const abs = Math.abs(delta).toLocaleString("en-IN", {
          maximumFractionDigits: 0,
        });
        setNpsMessage(`NAVs updated · 1D ${sign}₹${abs}${srcSuffix}`);
      }
    } else {
      setNpsMessage(
        npsRes.reason instanceof Error
          ? npsRes.reason.message
          : String(npsRes.reason)
      );
      setNpsStatus("error");
    }

    // ── Index highs branch ──
    if (indexRes.status === "fulfilled") {
      const ix = indexRes.value;
      setIndexUpdatedAt(new Date().toISOString());
      if (ix.failed === ix.total) {
        setIndexStatus("error");
      } else if (ix.failed > 0) {
        setIndexStatus("partial");
      } else {
        setIndexStatus("ok");
      }
      setIndexMessage(
        ix.failed > 0
          ? `${ix.refreshed}/${ix.total} refreshed · ${ix.failed} failed`
          : `${ix.refreshed}/${ix.total} indices refreshed`
      );
    } else {
      setIndexMessage(
        indexRes.reason instanceof Error
          ? indexRes.reason.message
          : String(indexRes.reason)
      );
      setIndexStatus("error");
    }

    // ── Combined status ──
    const mfOk = mfRes.status === "fulfilled";
    const npsOk = npsRes.status === "fulfilled";
    const indexOk =
      indexRes.status === "fulfilled" && indexRes.value.failed < indexRes.value.total;

    if (mfOk && npsOk) {
      // Both endpoints replied 200 with ok=true, but per-fund status
      // inside MF can still show failures — the endpoint always
      // returns 200 for a batch and enumerates per-fund outcomes in
      // counts. So we have to inspect counts.failed here (not just
      // counts.rotated) to avoid the "All NAVs up to date" contradiction
      // when everything actually errored per-fund.
      const mfCounts = mfRes.value.counts;
      const mfRotated = mfCounts.rotated;
      const mfFailed = mfCounts.failed;
      const mfSkippedStale = mfCounts.skipped_stale;
      const npsRotated =
        npsRes.value.already_fresh || npsRes.value.skipped_stale ? 0 : 1;

      // Decide overall state and headline message.
      if (mfFailed === mfCounts.total) {
        // Every MF fund errored — treat as error even though the HTTP
        // response was 200. NPS side may still have worked; the message
        // has to reflect that.
        setState("error");
        setMessage(
          npsRotated > 0
            ? "MF refresh failed for all funds · NPS refreshed. See MF panel for details."
            : "MF refresh failed for all funds. See MF panel for details."
        );
      } else if (mfFailed > 0) {
        // Partial MF failure — some rotated, some failed. Surface as
        // "partial" so the icon color reflects incomplete success.
        setState("partial");
        setMessage(
          `${mfRotated} MF fund(s) refreshed · ${mfFailed} MF fund(s) failed · NPS ${npsRotated > 0 ? "refreshed" : "up to date"}`
        );
      } else if (mfRotated === 0 && npsRotated === 0 && mfSkippedStale === 0) {
        setState("success");
        setMessage(
          "All NAVs up to date · Come back tomorrow morning for the next set."
        );
      } else if (mfSkippedStale > 0) {
        // mfapi returned data OLDER than DB — usually because a Groww
        // paste already landed a fresher NAV. Not an error; explicit
        // message so the user isn't confused about why the count is
        // less than expected.
        setState("success");
        setMessage(
          `${mfRotated} MF fund(s) refreshed · ${mfSkippedStale} skipped as stale · NPS ${npsRotated > 0 ? "refreshed" : "up to date"}`
        );
      } else {
        setState("success");
        const parts: string[] = [];
        if (mfRotated > 0) parts.push(`${mfRotated} MF fund(s) refreshed`);
        else parts.push("MF already up to date");
        if (npsRotated > 0) parts.push("NPS refreshed");
        else parts.push("NPS already up to date");
        setMessage(parts.join(" · "));
      }
    } else if (!mfOk && !npsOk) {
      setState("error");
      setMessage("Both refresh paths failed — see per-source details below.");
    } else {
      // Partial — one worked, one didn't. Success state (dashboard IS
      // more up to date now) but message flags the incomplete side.
      setState("success");
      setMessage(
        mfOk
          ? "MF refreshed · NPS failed (see details below)"
          : "NPS refreshed · MF failed (see details below)"
      );
    }

    // Fold in the index-highs outcome as a functional-update suffix
    // rather than expanding the MF/NPS combined logic above into a
    // 2×2×2 matrix — that block already covers the cases that matter
    // for the headline message; index highs is additive context. A
    // full index failure downgrades the overall state (never worse
    // than "error", never better than "partial") without needing to
    // know what mf/nps already decided.
    if (!indexOk) {
      setState((prev) => (prev === "error" ? "error" : "partial"));
      setMessage((prev) => (prev ? `${prev} · Index highs failed` : "Index highs failed"));
    } else if (indexRes.status === "fulfilled" && indexRes.value.failed > 0) {
      const { refreshed, total } = indexRes.value;
      setState((prev) => (prev === "error" ? "error" : "partial"));
      setMessage((prev) =>
        prev
          ? `${prev} · Index highs ${refreshed}/${total} refreshed`
          : `Index highs ${refreshed}/${total} refreshed`
      );
    } else if (indexRes.status === "fulfilled") {
      setMessage((prev) => (prev ? `${prev} · Index highs refreshed` : "Index highs refreshed"));
    }

    router.refresh();
  }

  const isLoading = state === "loading";

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <RefreshCwIcon size={16} />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Refresh NAVs
              </h3>
              <p className="mt-0.5 kicker">
                Mutual Funds · NPS · Index highs · Fetches latest prices
              </p>
            </div>
            <Button
              onClick={refresh}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5"
            >
              {isLoading ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Fetching…
                </>
              ) : (
                <>
                  <RefreshCw size={13} />
                  Refresh
                </>
              )}
            </Button>
          </div>

          {/* Three mini-panels side-by-side — MF, NPS, Index highs */}
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <MfPanel
              mf={mf}
              message={mfMessage}
              status={mfStatus}
              isLoading={isLoading}
            />
            <NpsPanel
              nps={nps}
              message={npsMessage}
              status={npsStatus}
              isLoading={isLoading}
            />
            <IndexPanel
              indexLevels={indexLevels}
              message={indexMessage}
              status={indexStatus}
              isLoading={isLoading}
              updatedAt={indexUpdatedAt}
            />
          </div>

          {message && (
            <div
              className={
                state === "error"
                  ? "mt-3 rounded-md border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--danger))]"
                  : state === "partial"
                    ? "mt-3 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--warning))]"
                    : "mt-3 rounded-md border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--success))]"
              }
            >
              {message}
            </div>
          )}

          {fallbackReason && (
            <details className="mt-2 text-[11px]">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Kotak primary path failed — click to see reason
              </summary>
              <div className="mt-2 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] px-3 py-2 font-mono text-[10px] text-[hsl(var(--warning))] break-all">
                {fallbackReason}
              </div>
            </details>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── MF mini-panel ────────────────────────────────────────────────────────

function MfPanel({
  mf,
  message,
  status,
  isLoading,
}: {
  mf: SyncData["mf"];
  message: string | null;
  status: "ok" | "partial" | "error" | null;
  isLoading: boolean;
}) {
  // Dot color prefers the explicit status from the last refresh call
  // when we have one — the endpoint knows exactly how many funds
  // failed. Falls back to freshness heuristic (nav_updated_at exists)
  // for the pre-first-click state.
  const dotColor: "success" | "warning" | "danger" =
    isLoading
      ? "warning"
      : status === "error"
        ? "danger"
        : status === "partial"
          ? "warning"
          : status === "ok"
            ? "success"
            : mf?.nav_updated_at
              ? "success"
              : "warning";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center gap-1.5">
        <TrendingUp size={12} className="text-muted-foreground" />
        <div className="kicker">Mutual Funds</div>
      </div>
      {mf ? (
        <>
          <div className="mt-1.5 text-sm font-semibold text-foreground">
            {fmtL(mf.total_value_inr)}
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
              · {mf.fund_count} funds
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
            <div className="flex items-center gap-1">
              <PulseDot color={dotColor} />
              <span className="text-muted-foreground">
                {mf.nav_updated_at ? (
                  <>
                    Last refreshed <TimeAgo isoDate={mf.nav_updated_at} />
                  </>
                ) : (
                  "Never refreshed"
                )}
              </span>
            </div>
            {mf.nav_date && (
              <span className="text-muted-foreground">
                · NAVs as of {fmtDateShort(mf.nav_date)}
              </span>
            )}
            {mf.nav_source && <MfSourceTag source={mf.nav_source} />}
            {mf.stale_fund_count > 0 && (
              <span
                className="rounded bg-[hsl(var(--warning)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--warning))]"
                title={`${mf.stale_fund_count} fund(s) have older NAV dates than the batch headline — usually FoF or international funds that publish T+2.`}
              >
                {mf.stale_fund_count} stale
              </span>
            )}
          </div>
          {message && (
            <div className="mt-2 text-[10px] text-muted-foreground">{message}</div>
          )}
        </>
      ) : (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          No funds yet — paste a Groww JSON to seed.
        </div>
      )}
    </div>
  );
}

// ── NPS mini-panel ───────────────────────────────────────────────────────

function NpsPanel({
  nps,
  message,
  status,
  isLoading,
}: {
  nps: SyncData["nps"];
  message: string | null;
  status: "ok" | "error" | null;
  isLoading: boolean;
}) {
  const dotColor: "success" | "warning" | "danger" = isLoading
    ? "warning"
    : status === "error"
      ? "danger"
      : status === "ok"
        ? "success"
        : nps?.nav_updated_at
          ? "success"
          : "warning";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center gap-1.5">
        <Landmark size={12} className="text-muted-foreground" />
        <div className="kicker">NPS</div>
      </div>
      {nps ? (
        <>
          <div className="mt-1.5 text-sm font-semibold text-foreground">
            {fmtL(nps.nps_value_inr)}
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
              · Tier I POP
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
            <div className="flex items-center gap-1">
              <PulseDot color={dotColor} />
              <span className="text-muted-foreground">
                {nps.nav_updated_at ? (
                  <>
                    Last refreshed <TimeAgo isoDate={nps.nav_updated_at} />
                  </>
                ) : (
                  "Never refreshed"
                )}
              </span>
            </div>
            {nps.nav_date && (
              <span className="text-muted-foreground">
                · NAVs as of {fmtDateShort(nps.nav_date)}
              </span>
            )}
            {nps.nav_source && <NpsSourceTag source={nps.nav_source} />}
            {!nps.has_prev && (
              <span
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                title="First refresh — 1D delta will populate on the next call."
              >
                First refresh
              </span>
            )}
          </div>
          {message && (
            <div className="mt-2 text-[10px] text-muted-foreground">{message}</div>
          )}
        </>
      ) : (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          No NPS data yet — seed via Settings.
        </div>
      )}
    </div>
  );
}

// ── Index highs mini-panel ───────────────────────────────────────────────

function IndexPanel({
  indexLevels,
  message,
  status,
  isLoading,
  updatedAt,
}: {
  indexLevels: SyncData["indexLevels"];
  message: string | null;
  status: "ok" | "partial" | "error" | null;
  isLoading: boolean;
  updatedAt: string | null;
}) {
  const dotColor: "success" | "warning" | "danger" = isLoading
    ? "warning"
    : status === "error"
      ? "danger"
      : status === "partial"
        ? "warning"
        : status === "ok"
          ? "success"
          : indexLevels.length > 0
            ? "success"
            : "warning";

  // Prefer the freshest DB row's updated_at over the just-fetched
  // updatedAt (which is only set after a click in THIS session) — so
  // the panel shows something meaningful on first render too.
  const dbUpdatedAt = indexLevels.reduce<string | null>(
    (max, r) => (max === null || r.updated_at > max ? r.updated_at : max),
    null
  );
  const lastRefreshed = updatedAt ?? dbUpdatedAt;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center gap-1.5">
        <LineChart size={12} className="text-muted-foreground" />
        <div className="kicker">Index highs</div>
      </div>
      {indexLevels.length > 0 ? (
        <>
          <div className="mt-1.5 text-sm font-semibold text-foreground">
            {indexLevels.length}
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
              indices tracked
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
            <div className="flex items-center gap-1">
              <PulseDot color={dotColor} />
              <span className="text-muted-foreground">
                {lastRefreshed ? (
                  <>
                    Last refreshed <TimeAgo isoDate={lastRefreshed} />
                  </>
                ) : (
                  "Never refreshed"
                )}
              </span>
            </div>
          </div>
          {message && (
            <div className="mt-2 text-[10px] text-muted-foreground">{message}</div>
          )}
        </>
      ) : (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Not refreshed yet — click Refresh to pull ATH/52w/3m highs.
        </div>
      )}
    </div>
  );
}

// ── Source badges ────────────────────────────────────────────────────────

function MfSourceTag({ source }: { source: MfNavSource }) {
  if (source === "amfi") {
    // AMFI is the authoritative daily bhavcopy — every MF NAV in India
    // flows from here. Same green success palette as 'mfapi' below
    // (both are "fresh, trustworthy, automated"), differentiated only
    // by label + tooltip so a user hovering can see which upstream
    // actually served today's number.
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-[hsl(var(--success)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--success))]"
        title="Fetched from AMFI's official NAVAll.txt — the authoritative daily NAV disclosure every AMC reports to."
      >
        <ShieldCheck size={9} />
        from AMFI
      </span>
    );
  }
  if (source === "mfapi") {
    // mfapi is the fallback path — kicks in for T+1 overseas funds
    // (until mid-morning IST) and when AMFI's snapshot fetch itself
    // fails. Warning palette so the user notices when a fund fell to
    // fallback, without treating it as an error.
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-[hsl(var(--warning)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--warning))]"
        title="Fetched from mfapi.in (AMFI fallback) — either the fund is a T+1 overseas scheme AMFI hadn't posted yet, or AMFI's file itself was unreachable."
      >
        <ShieldAlert size={9} />
        from mfapi
      </span>
    );
  }
  // 'groww'
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-[hsl(var(--primary)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--primary))]"
      title="Last update was a Groww JSON paste — next daily NAV refresh will replace with live AMFI/mfapi values."
    >
      <FileCheck size={9} />
      from Groww
    </span>
  );
}

function NpsSourceTag({ source }: { source: NavSource }) {
  if (source === "cas_reconciliation") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-[hsl(var(--primary)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--primary))]"
        title="Last update was a CAMS CAS reconciliation. Next daily NAV refresh will replace with live Kotak/npsnav.in values."
      >
        <FileCheck size={9} />
        from CAMS
      </span>
    );
  }
  const isKotak = source === "kotak";
  return (
    <span
      className={
        isKotak
          ? "inline-flex items-center gap-1 rounded bg-[hsl(var(--success)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--success))]"
          : "inline-flex items-center gap-1 rounded bg-[hsl(var(--warning)/0.15)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--warning))]"
      }
      title={
        isKotak
          ? "Fetched from Kotak's official API (authoritative source)"
          : "Fetched from npsnav.in — Kotak's API failed on this refresh (fallback engaged)"
      }
    >
      {isKotak ? <ShieldCheck size={9} /> : <ShieldAlert size={9} />}
      from {isKotak ? "Kotak" : "npsnav.in"}
    </span>
  );
}
