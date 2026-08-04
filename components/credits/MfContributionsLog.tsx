"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Landmark,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn, fmtDateIST, fmtINR } from "@/lib/utils";
import type { MfLedgerEntry } from "@/lib/queries";
import { deleteManualMfLedgerEntry } from "@/app/actions";
import { useVisibleMonths, currentMonthKey } from "./useVisibleMonths";
import { MonthPicker } from "./MonthPicker";
import {
  platformLabel,
  platformColorKey,
  PLATFORM_BADGE_STYLES,
} from "@/lib/mf/platform";

/**
 * Groww's order_status vocabulary → the four visual states we care
 * about in the log. Keeps the badge story simple:
 *   ok       → completed, units allotted
 *   pending  → still cooking (APPROVED, IN_PROGRESS, PLACED, etc.)
 *   fail     → failed / rejected — surfaces so user can retry/refund
 *   unknown  → anything else; render the raw value so we don't hide
 *              a status shape we haven't mapped yet
 */
type StatusTone = "ok" | "pending" | "fail" | "unknown";
function statusTone(status: string | null): StatusTone {
  if (!status) return "unknown";
  const s = status.toUpperCase();
  if (s === "COMPLETED") return "ok";
  if (s === "FAILED" || s === "REJECTED" || s === "CANCELLED") return "fail";
  if (
    s === "IN_PROGRESS" ||
    s === "APPROVED" ||
    s === "PLACED" ||
    s === "PENDING"
  )
    return "pending";
  return "unknown";
}
const STATUS_BADGE_VARIANT: Record<StatusTone, "success" | "warning" | "danger" | "muted"> = {
  ok: "success",
  pending: "warning",
  fail: "danger",
  unknown: "muted",
};
const STATUS_LABEL: Record<StatusTone, string> = {
  ok: "Completed",
  pending: "Pending",
  fail: "Failed",
  unknown: "Unknown",
};

/**
 * REDEMPTION shows as red (money out) and PURCHASE as neutral primary.
 * SWITCHes are marked as info-primary so they don't look like buys —
 * they're internal rebalances, not new inflow.
 */
type OrderKind = "purchase" | "redemption" | "switch" | "other";
function orderKind(orderType: string | null): OrderKind {
  if (!orderType) return "other";
  const t = orderType.toUpperCase();
  if (t === "PURCHASE") return "purchase";
  if (t === "REDEMPTION" || t === "REDEEM") return "redemption";
  if (t.startsWith("SWITCH")) return "switch";
  return "other";
}
const KIND_BADGE_VARIANT: Record<OrderKind, "primary" | "danger" | "warning" | "muted"> = {
  purchase: "primary",
  redemption: "danger",
  switch: "warning",
  other: "muted",
};
const KIND_LABEL: Record<OrderKind, string> = {
  purchase: "Purchase",
  redemption: "Redemption",
  switch: "Switch",
  other: "Order",
};

// ─── Month bucketing ─────────────────────────────────────────────────────
type MonthBucket = {
  key: string;                 // "YYYY-MM"
  label: string;               // "Jul 2026"
  count: number;
  purchaseInr: number;         // sum of PURCHASE.amount_inr in this month
  redemptionInr: number;       // sum of REDEMPTION.amount_inr in this month
  orders: MfLedgerEntry[];
};

function bucketByMonth(orders: MfLedgerEntry[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const o of orders) {
    const key = o.order_date.slice(0, 7);
    let bucket = map.get(key);
    if (!bucket) {
      const [y, m] = key.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1, 1));
      const label = d.toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      bucket = {
        key,
        label,
        count: 0,
        purchaseInr: 0,
        redemptionInr: 0,
        orders: [],
      };
      map.set(key, bucket);
    }
    bucket.orders.push(o);
    bucket.count++;
    const amt = Number(o.amount_inr ?? 0);
    const kind = orderKind(o.order_type);
    if (kind === "purchase") bucket.purchaseInr += amt;
    else if (kind === "redemption") bucket.redemptionInr += amt;
  }
  return Array.from(map.values());
}

// ─── Main component ──────────────────────────────────────────────────────

export function MfContributionsLog({
  entries,
  pendingCount,
}: {
  entries: MfLedgerEntry[];
  pendingCount: number;
}) {
  const router = useRouter();
  const [deletePending, startDeleteTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] =
    useState<MfLedgerEntry | null>(null);

  // Filter chip: "All funds" or specific fund_code. Unresolved rows
  // (fund_code IS NULL) are grouped under a synthetic "__unresolved__"
  // key so the user can find them if they need to fix mappings.
  const [fundFilter, setFundFilter] = useState<string>("__all__");

  function handleDeleteManualEntry(entry: MfLedgerEntry) {
    if (entry.source !== "manual" || deletePending) return;
    setDeleteError(null);
    setConfirmDeleteEntry(entry);
  }

  function handleConfirmDeleteManualEntry() {
    const entry = confirmDeleteEntry;
    if (!entry || entry.source !== "manual") return;

    setDeleteError(null);
    setDeletingId(entry.id);
    startDeleteTransition(async () => {
      try {
        const result = await deleteManualMfLedgerEntry({ tx_hash: entry.id });
        if (!result.ok) {
          setDeleteError(result.error);
          return;
        }
        setConfirmDeleteEntry(null);
        router.refresh();
      } finally {
        setDeletingId(null);
      }
    });
  }

  // Keep the dialog behavior aligned with other app modals.
  useEffect(() => {
    if (!confirmDeleteEntry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletePending) {
        setDeleteError(null);
        setConfirmDeleteEntry(null);
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [confirmDeleteEntry, deletePending]);

  // Available filter values — derived from data so it stays in sync
  // even as new funds show up in future backfills. Each entry carries
  // its row count so the <option> label can show "EDEL_MID (23)" and
  // the user can eyeball fund activity without opening each one.
  // Sort stays alphabetical (matches the muscle memory of the fund
  // codes being roughly grouped by AMC — HDFC_*, PPFAS_*, UTI_*).
  const fundOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of entries) {
      const key = o.fund_code ?? "__unresolved__";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [entries]);

  const filtered = useMemo(() => {
    if (fundFilter === "__all__") return entries;
    return entries.filter(
      (o) => (o.fund_code ?? "__unresolved__") === fundFilter
    );
  }, [entries, fundFilter]);

  const buckets = useMemo(() => bucketByMonth(filtered), [filtered]);
  // Year totals span every bucket — the picker uses these to render
  // "Show 2026 (85 of 172)" so the year-rollup count agrees with
  // "All funds (N)" instead of only counting older/hidden months.
  const yearTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const b of buckets) {
      const year = b.key.slice(0, 4);
      totals[year] = (totals[year] ?? 0) + b.count;
    }
    return totals;
  }, [buckets]);
  const { visible, olderOptions, extraKeys, addMonths, reset } =
    useVisibleMonths(buckets, 3);

  // On first render, everything except the current month is
  // collapsed — a month can hold 20–30 purchase + top-up entries,
  // so expanding all by default would swamp the page. Re-mounts
  // reset to this default.
  const currentKey = currentMonthKey();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const b of buckets) if (b.key !== currentKey) initial.add(b.key);
    return initial;
  });
  function toggleBucket(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const emptyState = entries.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* ── Section header ─────────────────────────────────── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]">
              <Landmark size={14} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                MF contributions
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every purchase, redemption, and switch across all folios.
                Historical rows from MFCentral CAS; fresh orders from
                Groww.{" "}
                <Link
                  href="/sync"
                  className="text-[hsl(var(--primary))] hover:underline"
                >
                  Ingest more on Sync
                </Link>
                .
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {fundOptions.length > 1 && (
              <select
                value={fundFilter}
                onChange={(e) => setFundFilter(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="__all__">
                  All funds ({entries.length})
                </option>
                {fundOptions.map(({ code, count }) => (
                  <option key={code} value={code}>
                    {code === "__unresolved__" ? "Unresolved" : code} (
                    {count})
                  </option>
                ))}
              </select>
            )}
            <MonthPicker
              olderOptions={olderOptions}
              yearTotals={yearTotals}
              hasExtras={extraKeys.size > 0}
              onPick={addMonths}
              onReset={reset}
            />
          </div>
        </div>

        {pendingCount > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.05)] p-2.5 text-xs">
            <Clock3
              size={14}
              className="mt-0.5 shrink-0 text-[hsl(var(--warning))]"
            />
            <div>
              <div className="font-semibold text-[hsl(var(--warning))]">
                {pendingCount} Groww{" "}
                {pendingCount === 1 ? "order" : "orders"} in progress
              </div>
              <div className="mt-0.5 text-muted-foreground">
                Units are allotted on the next working day after
                placement. Re-paste the Groww order list once they
                complete — merge is automatic. CAS-sourced rows are
                already settled and don&apos;t appear here.
              </div>
            </div>
          </div>
        )}

        {deleteError && (
          <div className="mt-3 rounded-md border border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-xs text-[hsl(var(--danger))]">
            {deleteError}
          </div>
        )}
      </Card>

      {/* ── Empty state ────────────────────────────────────── */}
      {emptyState && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No contributions yet. Head to{" "}
          <Link
            href="/sync"
            className="text-[hsl(var(--primary))] hover:underline"
          >
            Sync
          </Link>{" "}
          → &ldquo;MF contributions (order history)&rdquo; and paste
          your Groww order list to backfill.
        </Card>
      )}

      {/* ── Monthly buckets ────────────────────────────────── */}
      {/* Only the last 3 months (with data) render by default; older
          months are one dropdown-pick away via the header picker.
          Trades happen daily/weekly so this could otherwise become a
          very long scroll after a few years of history. */}
      {visible.map((bucket) => {
        const isCollapsed = collapsed.has(bucket.key);
        const netInr = bucket.purchaseInr - bucket.redemptionInr;
        return (
          <Card key={bucket.key} className="p-0">
            <button
              onClick={() => toggleBucket(bucket.key)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/20"
            >
              <div className="flex items-center gap-2">
                {isCollapsed ? (
                  <ChevronRight size={14} className="text-muted-foreground" />
                ) : (
                  <ChevronDown size={14} className="text-muted-foreground" />
                )}
                <span className="text-sm font-semibold text-foreground">
                  {bucket.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  · {bucket.count}{" "}
                  {bucket.count === 1 ? "order" : "orders"}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                {bucket.redemptionInr > 0 && (
                  <span className="text-xs tabular-nums text-[hsl(var(--danger))]">
                    −{fmtINR(bucket.redemptionInr)}
                  </span>
                )}
                <span
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    netInr >= 0
                      ? "text-[hsl(var(--success))]"
                      : "text-[hsl(var(--danger))]"
                  )}
                >
                  {netInr >= 0 ? "+" : "−"}
                  {fmtINR(Math.abs(netInr))}
                </span>
              </div>
            </button>

            {!isCollapsed && (
              <div className="border-t border-border">
                {/* Header row — desktop only. Grid template must match
                    the row grid template below to stay aligned. Date
                    column shows Placed on top (large) + NAV / Allotted
                    stacked below (small) — 140px accommodates the widest
                    small line "Allotted 18 Jul 2026". Fund uses
                    minmax(0,1fr) so long scheme names truncate. */}
                <div className="hidden grid-cols-[140px_100px_minmax(0,_1fr)_100px_110px_100px] items-start gap-3 border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
                  <span>Placed</span>
                  <span>Type</span>
                  <span>Fund</span>
                  <span className="text-right">Units</span>
                  <span className="text-right">NAV</span>
                  <span className="text-right">Amount</span>
                </div>
                <ul>
                  {bucket.orders.map((o) => {
                    const kind = orderKind(o.order_type);
                    const tone = statusTone(o.order_status);
                    const isRedemption = kind === "redemption";
                    // Three ingest sources with distinct visual + semantic
                    // meaning: CAS (RTA-reconciled), Groww (broker's own
                    // record), Manual (user-typed or INDmoney bulk-paste
                    // — pre-CAS-reconciliation). See MfLedgerEntry.source
                    // in lib/queries.ts for the full taxonomy.
                    const isCas = o.source === "cas";
                    const isManual = o.source === "manual";
                    const isGroww = o.source === "groww";
                    return (
                      <li
                        key={o.id}
                        className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[140px_100px_minmax(0,_1fr)_100px_110px_100px] md:items-start md:gap-3"
                      >
                        {/* Lifecycle stacked. Two very different render
                            paths depending on source:

                            • Groww (has placed_at): NAV date IS the
                              order_date; completion_date is the T+1
                              allotment day. Three-line "Placed / NAV /
                              Allotted" stack surfaces the whole
                              lifecycle for the user's audit.

                            • CAS (no placed_at, no completion_date):
                              tx_date is authoritative from the RTA
                              side and IS the settlement day. We
                              collapse to a single-line label —
                              anything else would render bare "—"s
                              and imply missing data. */}
                        <div className="whitespace-nowrap tabular-nums">
                          {isCas ? (
                            <>
                              <div className="text-sm font-semibold text-foreground">
                                {fmtDateIST(o.order_date)}
                              </div>
                              <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                                Settled (RTA)
                              </div>
                            </>
                          ) : isManual ? (
                            // Manual / INDmoney-paste rows. Two dates
                            // matter, laid out to match the Groww
                            // convention beneath (which the "PLACED"
                            // column header assumes):
                            //   Line 1 (large): PLACED date  — matches
                            //                    the column header. For
                            //                    INDmoney bulk-list rows
                            //                    this is Subtitle1 (the
                            //                    click date); for the
                            //                    hand-typed manual form
                            //                    it's the tx_date the
                            //                    user picked (there's no
                            //                    separate placed_date on
                            //                    that ingest path today).
                            //   Line 2 (small): "NAV <date>" — labelled
                            //                    just like the Groww row.
                            //                    Shown whenever a distinct
                            //                    placed date exists (i.e.
                            //                    post-3PM-cutoff INDmoney
                            //                    orders). When there's no
                            //                    distinct placed date, the
                            //                    top-line date already IS
                            //                    the NAV date, so we tag it
                            //                    "NAV date" instead of
                            //                    hiding the label.
                            //
                            // Rationale: earlier iteration flipped these
                            // (NAV big, "Placed" subtitle) which broke
                            // visual parity with Groww under the same
                            // column header — user reasonably asked
                            // "where's the NAV date?" of a top-line date
                            // that had no label. Sticking with Groww's
                            // layout means "big number = placed" holds
                            // across every non-CAS row.
                            <>
                              <div className="text-sm font-semibold text-foreground">
                                {fmtDateIST(o.placed_date ?? o.order_date)}
                              </div>
                              {o.placed_date &&
                              o.placed_date !== o.order_date ? (
                                <div
                                  className="mt-0.5 text-[10px] leading-tight text-muted-foreground"
                                  title="Post-3PM-cutoff order (or placed on a non-trading day) — the AMC applied the NAV of the next trading day, not the click day."
                                >
                                  NAV {fmtDateIST(o.order_date)}
                                </div>
                              ) : (
                                // Hand-typed manual rows have no distinct placed date, so the top-line date already IS the picked NAV date — tag it so the NAV date is never invisible.
                                <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                                  NAV date
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="text-sm font-semibold text-foreground">
                                {o.placed_at ? fmtDateIST(o.placed_at) : "—"}
                              </div>
                              <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                                NAV {fmtDateIST(o.order_date)}
                              </div>
                              <div className="text-[10px] leading-tight text-muted-foreground">
                                Allotted{" "}
                                {/* Prefer the DB-stored completion_date
                                    (from Groww's DETAIL orderTrackRecords,
                                    ingested when the sync-mf-contributions
                                    API existed pre-2026-07-24). Fall back
                                    to order_date for any COMPLETED row
                                    where the tracker event wasn't in
                                    the paste. Older ingests have null
                                    completion_date on file — this render
                                    fallback covers them without re-
                                    ingestion. Since the ingest UI is
                                    now retired, no new rows land here
                                    with null completion_date; the
                                    fallback exists purely for historical
                                    rows. */}
                                {(() => {
                                  const allot =
                                    o.completion_date ??
                                    (o.order_status?.toUpperCase() ===
                                    "COMPLETED"
                                      ? o.order_date
                                      : null);
                                  return allot ? fmtDateIST(allot) : "—";
                                })()}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Type + Status + Source */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={KIND_BADGE_VARIANT[kind]}>
                            {isRedemption ? (
                              <ArrowDownRight size={10} />
                            ) : (
                              <ArrowUpRight size={10} />
                            )}
                            {KIND_LABEL[kind]}
                          </Badge>
                          {/* Groww-only status pill; CAS is always
                              settled and Manual entries only ever get
                              logged for completed orders (in-progress/
                              cancelled orders are filtered out at paste
                              time — see LogMfTxCard.handleParsePaste).
                              Both sources have nothing status-wise to
                              communicate, so this pill is Groww-only. */}
                          {isGroww && tone !== "ok" && (
                            <Badge variant={STATUS_BADGE_VARIANT[tone]}>
                              {STATUS_LABEL[tone]}
                            </Badge>
                          )}
                          {/* Provenance chip — CAS or Groww only.
                              Manual rows deliberately show no source
                              chip: the platform badge (rendered below)
                              already tells the user where the trade
                              came from (INDmoney / ICICI Prudential /
                              etc.), and a "MANUAL" chip alongside adds
                              no extra signal — just visual clutter.
                              CAS chip stays because "RTA-reconciled" is
                              orthogonal info from platform. Groww chip
                              stays because Groww rows suppress their
                              platform badge (same-source-as-platform
                              redundancy is handled there). */}
                          {(isCas || isGroww) && (
                            <span
                              className={cn(
                                "rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                                isCas
                                  ? "bg-muted/40 text-muted-foreground"
                                  : "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]"
                              )}
                              title={
                                isCas
                                  ? "Ingested from MFCentral eCAS — RTA-authoritative"
                                  : "Ingested from Groww order history"
                              }
                            >
                              {isCas ? "CAS" : "Groww"}
                            </span>
                          )}
                          {/* Platform chip — where the trade was actually
                              placed (Groww / INDmoney / ICICI Prudential
                              direct-AMC app / etc.), a distinct dimension
                              from ingest source above. Suppressed when it
                              would just duplicate the source pill (Groww-
                              ingested rows placed on Groww). Null platform
                              stays hidden — same "no info to show" story
                              as suppressing an empty status badge. */}
                          {o.platform && !(o.source === "groww" && o.platform === "groww") && (
                            <span
                              className={cn(
                                "rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                                PLATFORM_BADGE_STYLES[platformColorKey(o.platform)]
                              )}
                              title={`Placed on ${platformLabel(o.platform)}`}
                            >
                              {platformLabel(o.platform)}
                            </span>
                          )}
                        </div>

                        {/* Fund — code if resolved, scheme_name fallback.
                            min-w-0 + truncate on scheme_name so long names
                            ("Parag Parikh Flexi Cap Fund Direct Growth")
                            ellipsis instead of wrapping and blowing up
                            row height. */}
                        <div className="min-w-0 text-xs">
                          {o.fund_code ? (
                            <>
                              <span className="font-mono font-semibold text-foreground">
                                {o.fund_code}
                              </span>
                              {o.scheme_name && (
                                <div
                                  className="mt-0.5 truncate text-[10px] text-muted-foreground"
                                  title={o.scheme_name}
                                >
                                  {o.scheme_name}
                                </div>
                              )}
                              {o.folio_number && (
                                <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                                  #{o.folio_number}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground italic">
                              {o.scheme_name ?? "—"}
                              <span className="ml-1 text-[10px] text-[hsl(var(--warning))]">
                                (unmapped)
                              </span>
                            </span>
                          )}
                        </div>

                        {/* Units */}
                        <div className="text-right text-xs tabular-nums text-muted-foreground md:text-foreground">
                          {o.units != null ? (
                            Number(o.units).toLocaleString("en-IN", {
                              minimumFractionDigits: 3,
                              maximumFractionDigits: 3,
                            })
                          ) : (
                            <span className="text-muted-foreground/60">
                              —
                            </span>
                          )}
                        </div>

                        {/* NAV */}
                        <div className="text-right text-xs tabular-nums text-muted-foreground">
                          {o.nav != null ? (
                            `₹${Number(o.nav).toLocaleString("en-IN", {
                              minimumFractionDigits: 4,
                              maximumFractionDigits: 4,
                            })}`
                          ) : (
                            <span className="text-muted-foreground/60">
                              —
                            </span>
                          )}
                        </div>

                        {/* Amount — sign-flipped for redemptions */}
                        <div
                          className={cn(
                            "text-right text-sm font-semibold tabular-nums",
                            isRedemption
                              ? "text-[hsl(var(--danger))]"
                              : "text-[hsl(var(--success))]"
                          )}
                        >
                          {o.amount_inr != null
                            ? `${isRedemption ? "−" : "+"}${fmtINR(
                                Number(o.amount_inr)
                              )}`
                            : "—"}
                          {isManual && (
                            <div className="mt-1">
                              <button
                                type="button"
                                onClick={() => handleDeleteManualEntry(o)}
                                disabled={deletePending}
                                className="inline-flex items-center gap-1 rounded border border-[hsl(var(--danger)/0.3)] px-1.5 py-0.5 text-[10px] font-medium text-[hsl(var(--danger))] hover:bg-[hsl(var(--danger)/0.08)] disabled:pointer-events-none disabled:opacity-50"
                                title="Delete this manual MF entry"
                              >
                                {deletePending && deletingId === o.id ? (
                                  <Loader2 size={10} className="animate-spin" />
                                ) : (
                                  <Trash2 size={10} />
                                )}
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>
        );
      })}

      {confirmDeleteEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deletePending) {
              setDeleteError(null);
              setConfirmDeleteEntry(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mf-delete-confirm-title"
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"
          >
            <h3
              id="mf-delete-confirm-title"
              className="text-base font-semibold text-foreground"
            >
              Delete manual MF entry?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will permanently delete the entry and update holdings totals.
            </p>

            <div className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground">
              <div className="font-medium">
                {confirmDeleteEntry.fund_code ??
                  confirmDeleteEntry.scheme_name ??
                  "Manual entry"}
              </div>
              <div className="mt-1 text-muted-foreground">
                {fmtDateIST(confirmDeleteEntry.order_date)}
                {confirmDeleteEntry.amount_inr != null
                  ? ` · ${fmtINR(Number(confirmDeleteEntry.amount_inr))}`
                  : ""}
              </div>
            </div>

            {deleteError && (
              <p className="mt-3 rounded-md border border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-xs text-[hsl(var(--danger))]">
                {deleteError}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deletePending}
                onClick={() => {
                  setDeleteError(null);
                  setConfirmDeleteEntry(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={deletePending}
                onClick={handleConfirmDeleteManualEntry}
                className="bg-[hsl(var(--danger))] text-white hover:bg-[hsl(var(--danger)/0.9)]"
              >
                {deletePending && deletingId === confirmDeleteEntry.id ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
                Confirm delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
