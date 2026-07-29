"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  PiggyBank,
  Sparkles,
  Trash2,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fmtDate, fmtINR } from "@/lib/utils";
import { deleteRetirementCredit } from "@/app/actions";
import type { RetirementCredit, CreditType } from "@/lib/queries";
import { useVisibleMonths, currentMonthKey } from "./useVisibleMonths";
import { MonthPicker } from "./MonthPicker";

// The log-a-credit-event form used to live inline in this component;
// it moved to /sync (see components/sync/LogCreditEventCard.tsx) so
// this file is now a pure viewing surface + delete affordance.

const TYPE_LABELS: Record<CreditType, string> = {
  payroll: "Payroll",
  interest: "Interest",
};

const TYPE_VARIANT: Record<CreditType, "primary" | "warning"> = {
  payroll: "primary",
  interest: "warning",
};

// ─── Month bucketing helpers ─────────────────────────────────────────────

/**
 * Group a flat descending-date list of credits into monthly buckets keyed
 * by "YYYY-MM". Each bucket carries the display label ("Jul 2026") and a
 * running total for the header. Insertion order is preserved (i.e., most
 * recent month first) because we iterate the pre-sorted input.
 */
type MonthBucket = {
  key: string;
  label: string;
  // Mirrors the field name on MfContributionsLog's MonthBucket so the
  // shared MonthPicker can render "Jun 2026 (3)" from either page
  // without a shape-specific adapter. Equal to `credits.length`; kept
  // as a plain field so the picker doesn't have to reach into the
  // array (and pay the memory hit) just to count.
  count: number;
  totalInr: number;
  credits: RetirementCredit[];
};

function bucketByMonth(credits: RetirementCredit[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const c of credits) {
    // credit_date is YYYY-MM-DD from Postgres; slice(0,7) = YYYY-MM
    const key = c.credit_date.slice(0, 7);
    let bucket = map.get(key);
    if (!bucket) {
      const [y, m] = key.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1, 1));
      const label = d.toLocaleString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      bucket = { key, label, count: 0, totalInr: 0, credits: [] };
      map.set(key, bucket);
    }
    bucket.credits.push(c);
    bucket.count++;
    bucket.totalInr += Number(c.amount_inr);
  }
  return Array.from(map.values());
}

// ─── Main component ──────────────────────────────────────────────────────

export function CreditsLog({
  credits,
  currentMonthLogged,
}: {
  credits: RetirementCredit[];
  currentMonthLogged: { epfPayroll: boolean; npsPayroll: boolean };
}) {
  // ── Delete-per-row state ───────────────────────────────────
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [, startDelete] = useTransition();

  // ── Buckets ────────────────────────────────────────────────
  // Only render months that have at least one credit — no "No
  // credits" placeholder cards for empty months (they used to bloat
  // the list to 12 items even when the user had only touched a few
  // months this year).
  const buckets = useMemo(() => bucketByMonth(credits), [credits]);
  // Year totals span every bucket — the picker uses these to render
  // "Show 2026 (85 of 172)" so the year-rollup count agrees with the
  // total, not just the older/hidden slice. Mirrors the same wiring
  // in MfContributionsLog so both logs share picker behaviour.
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

  // ── Collapse state (per-month) ─────────────────────────────
  // On first render, everything except the current month is
  // collapsed. This is a per-mount state; re-mounting (page nav)
  // resets to the same default.
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

  function submitDelete(id: number) {
    setDeleteFeedback(null);
    setPendingDeleteId(id);
    startDelete(async () => {
      const res = await deleteRetirementCredit({ id });
      setPendingDeleteId(null);
      if (!res.ok) {
        setDeleteFeedback({ id, text: res.error });
      }
    });
  }

  return (
    // gap-3 mirrors MfContributionsLog so the two sections have
    // identical vertical rhythm when stacked on the Credits page.
    <div className="flex flex-col gap-3">
      {/* ── Section header ─────────────────────────────────── */}
      {/* Matches the visual pattern of MfContributionsLog's header so
          the two logs read as distinct sections instead of one long
          continuation. Piggy-bank icon nods to the retirement corpus
          nature (long-term savings) and differentiates from the MF
          section's Landmark icon. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(280_65%_75%/0.15)] text-[hsl(280_65%_75%)]">
              <PiggyBank size={14} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Retirement credits
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                EPF and NPS corpus credits (payroll + EPF interest).{" "}
                <Link
                  href="/sync#log-credit"
                  className="text-[hsl(var(--primary))] hover:underline"
                >
                  Log a new event on Sync
                </Link>
                . Showing the last 3 months with activity — pick older
                months from the dropdown when you need them.
              </p>
            </div>
          </div>
          <MonthPicker
            olderOptions={olderOptions}
            yearTotals={yearTotals}
            hasExtras={extraKeys.size > 0}
            onPick={addMonths}
            onReset={reset}
          />
        </div>
      </Card>

      {/* ── Missing-this-month nudge ────────────────────────── */}
      {(!currentMonthLogged.epfPayroll || !currentMonthLogged.npsPayroll) && (
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(45_85%_60%/0.15)] text-[hsl(45_85%_60%)]">
                <Sparkles size={14} />
              </span>
              <div className="text-sm">
                <div className="font-semibold text-foreground">
                  Nothing logged for this month yet
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {!currentMonthLogged.epfPayroll && (
                    <div>
                      · EPF payroll not recorded — check EPFO SMS / passbook
                    </div>
                  )}
                  {!currentMonthLogged.npsPayroll && (
                    <div>
                      · NPS payroll not recorded — check NPS statement
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* Deep-link to the form on Sync so the user doesn't have
                to hunt for where to log it. */}
            <Link
              href="/sync#log-credit"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/40"
            >
              Log it on Sync
              <ArrowUpRight size={12} />
            </Link>
          </div>
        </Card>
      )}

      {/* ── Monthly ledger ─────────────────────────────────── */}
      {/* Empty state: user has zero credits ever OR they've filtered
          themselves into an empty view. First case gets a hint; second
          case shouldn't happen since the picker only offers months
          with data. */}
      {visible.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No retirement credits logged yet.{" "}
          <Link
            href="/sync#log-credit"
            className="text-[hsl(var(--primary))] hover:underline"
          >
            Log your first one on Sync
          </Link>
          .
        </Card>
      )}
      {visible.map((bucket) => {
          const isCollapsed = collapsed.has(bucket.key);
          const isFullMonthLabel = new Date(
            Date.UTC(
              Number(bucket.key.slice(0, 4)),
              Number(bucket.key.slice(5, 7)) - 1,
              1
            )
          ).toLocaleString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          });

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
                    {isFullMonthLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    · {bucket.credits.length}{" "}
                    {bucket.credits.length === 1 ? "credit" : "credits"}
                  </span>
                </div>
                <span className="text-sm font-semibold tabular-nums text-[hsl(var(--success))]">
                  +{fmtINR(bucket.totalInr)}
                </span>
              </button>

              {!isCollapsed && (
                <div className="border-t border-border">
                  <div className="hidden grid-cols-[80px_100px_1fr_1.2fr_120px_36px] items-center gap-3 border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid">
                    <span>Source</span>
                    <span>Type</span>
                    <span>Date</span>
                    <span>Note</span>
                    <span className="text-right">Amount</span>
                    <span />
                  </div>
                  <ul>
                    {bucket.credits.map((c) => (
                      <li
                        key={c.id}
                        className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[80px_100px_1fr_1.2fr_120px_36px] sm:items-center sm:gap-3"
                      >
                        <div>
                          <Badge
                            variant={c.source === "EPF" ? "primary" : "intl"}
                          >
                            {c.source}
                          </Badge>
                        </div>
                        <div>
                          <Badge variant={TYPE_VARIANT[c.credit_type]}>
                            {TYPE_LABELS[c.credit_type]}
                          </Badge>
                        </div>
                        <div className="text-xs text-foreground">
                          {fmtDate(c.credit_date)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.note || "—"}
                        </div>
                        <div className="text-right text-sm font-semibold tabular-nums text-[hsl(var(--success))]">
                          +{fmtINR(Number(c.amount_inr))}
                        </div>
                        <div className="flex justify-end">
                          <button
                            onClick={() => submitDelete(c.id)}
                            disabled={pendingDeleteId === c.id}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--danger)/0.15)] hover:text-[hsl(var(--danger))]"
                            title="Delete credit (reverses corpus effect)"
                          >
                            {pendingDeleteId === c.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                          </button>
                        </div>
                        {deleteFeedback?.id === c.id && (
                          <div className="col-span-full text-xs text-[hsl(var(--danger))]">
                            <AlertTriangle
                              size={11}
                              className="mr-1 inline"
                            />
                            {deleteFeedback.text}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          );
        })}
    </div>
  );
}

