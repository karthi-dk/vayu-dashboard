"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn, fmtDateShort, fmtL } from "@/lib/utils";
import type { FundResyncStatus } from "@/lib/queries";
import { FUND_ISIN } from "@/lib/fundIsin";
import { FundDetailsModal } from "./FundDetailsModal";
import { TimeAgo } from "@/components/ui/TimeAgo";

function StateBadge({ f, override }: { f: FundResyncStatus; override?: FundResyncStatus["state"] }) {
  const state = override ?? f.state;
  if (state === "syncing")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--primary)/0.2)] px-2 py-0.5 text-[10px] font-semibold text-[hsl(var(--primary))]">
        <Loader2 size={9} className="animate-spin" />
        Syncing
      </span>
    );
  if (state === "error") {
    // "error" here means low look-through coverage (< 95%), which for debt
    // and hybrid funds is expected — bond ISINs aren't in master_security_
    // classification yet. Distinguished from a failed sync (which surfaces
    // an inline error message below the card) by context.
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--warning)/0.2)] px-2 py-0.5 text-[10px] font-semibold text-[hsl(var(--warning))]">
        <AlertTriangle size={9} />
        Low coverage
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--success)/0.15)] px-2 py-0.5 text-[10px] font-semibold text-[hsl(var(--success))]">
      <CheckCircle2 size={9} />
      Healthy
    </span>
  );
}

export function FundResyncGrid({ funds }: { funds: FundResyncStatus[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<
    { done: number; total: number; failed: number } | null
  >(null);
  const [selectedFund, setSelectedFund] = useState<string | null>(null);

  async function resyncOne(fund: FundResyncStatus): Promise<{ ok: boolean; error?: string }> {
    const isin = FUND_ISIN[fund.fund_code];
    if (!isin) {
      const msg = "Missing scheme ISIN mapping. Add to FUND_ISIN in lib/fundIsin.ts.";
      setErrors((e) => ({ ...e, [fund.fund_code]: msg }));
      return { ok: false, error: msg };
    }
    setBusy((b) => ({ ...b, [fund.fund_code]: true }));
    setErrors((e) => ({ ...e, [fund.fund_code]: null }));
    try {
      const res = await fetch(`/api/sync-fund-holdings/${isin}`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      setErrors((er) => ({ ...er, [fund.fund_code]: msg }));
      return { ok: false, error: msg };
    } finally {
      setBusy((b) => ({ ...b, [fund.fund_code]: false }));
    }
  }

  async function resync(fund: FundResyncStatus) {
    await resyncOne(fund);
    router.refresh();
  }

  async function resyncAll() {
    // Fires all 10 requests concurrently. Dhan handles this fine (verified
    // 2026-07-14) and Vercel serverless functions scale horizontally, so
    // fan-out is ~2-3s total vs ~15s sequential. If Dhan ever rate-limits,
    // switch to `for` loop with `await` for sequential behavior.
    setBulkRunning(true);
    setBulkSummary({ done: 0, total: funds.length, failed: 0 });
    let done = 0;
    let failed = 0;
    await Promise.all(
      funds.map(async (f) => {
        const r = await resyncOne(f);
        done += 1;
        if (!r.ok) failed += 1;
        setBulkSummary({ done, total: funds.length, failed });
      })
    );
    setBulkRunning(false);
    router.refresh();
  }

  function jumpToHoldings(fundCode: string) {
    setSelectedFund(fundCode);
  }

  return (
    <>
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Fetch fund holdings
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pull latest holdings from Dhan for a single fund · click a card
            to view its holdings
          </p>
          {bulkSummary && (
            <p
              className={cn(
                "mt-1 text-[11px] font-medium",
                bulkRunning
                  ? "text-[hsl(var(--primary))]"
                  : bulkSummary.failed > 0
                  ? "text-[hsl(var(--danger))]"
                  : "text-[hsl(var(--success))]"
              )}
            >
              {bulkRunning
                ? `Resyncing ${bulkSummary.done}/${bulkSummary.total}…`
                : bulkSummary.failed > 0
                ? `Done — ${bulkSummary.total - bulkSummary.failed} succeeded, ${bulkSummary.failed} failed`
                : `All ${bulkSummary.total} funds resynced successfully`}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={resyncAll}
          disabled={bulkRunning}
        >
          {bulkRunning ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {bulkRunning ? "Resyncing all…" : "Resync all"}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {funds.map((f) => {
          const b = busy[f.fund_code];
          const err = errors[f.fund_code];
          const hasNonSec = f.nonsec_rows > 0;
          return (
            <div
              key={f.fund_code}
              onClick={() => jumpToHoldings(f.fund_code)}
              className="group cursor-pointer rounded-lg border border-border bg-muted/20 p-4 transition-colors hover:border-[hsl(var(--primary)/0.5)] hover:bg-muted/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {f.fund_name}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                      {f.fund_code}
                    </span>
                    <Badge variant={f.cap_type}>{f.cap_type}</Badge>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      · {fmtL(f.current_value_inr)}
                    </span>
                  </div>
                </div>
                <StateBadge f={f} override={b ? "syncing" : undefined} />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                <div>
                  <div className="kicker">Holdings</div>
                  <div className="mt-0.5 font-semibold text-foreground">
                    {f.detail_rows}
                    {hasNonSec && (
                      <span className="text-muted-foreground">
                        {" "}
                        + {f.nonsec_rows}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {hasNonSec ? "securities · non-sec" : "securities"}
                  </div>
                </div>
                <div>
                  <div className="kicker">Data as of</div>
                  <div className="mt-0.5 font-semibold text-foreground">
                    {fmtDateShort(f.portfolio_date)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Dhan disclosure
                  </div>
                </div>
              </div>

              <div className="mt-3 text-[10px] text-muted-foreground">
                Resynced <TimeAgo isoDate={f.updated_at} />
              </div>

              {f.unresolved_count > 0 && (
                <div className="mt-2 flex items-center gap-1.5 rounded bg-[hsl(var(--warning)/0.12)] px-2 py-1.5 text-[10px] text-[hsl(var(--warning))]">
                  <AlertTriangle size={11} className="shrink-0" />
                  <span>
                    <span className="font-semibold">{f.unresolved_count}</span>{" "}
                    new {f.unresolved_count === 1 ? "holding" : "holdings"} from
                    Dhan{" "}
                    {f.unresolved_weight_pct > 0
                      ? `(${f.unresolved_weight_pct.toFixed(1)}% weight)`
                      : ""}{" "}
                    · click card for details
                  </span>
                </div>
              )}

              {err && (
                <div className="mt-2 rounded bg-[hsl(var(--danger)/0.15)] px-2 py-1 text-[10px] text-[hsl(var(--danger))]">
                  {err}
                </div>
              )}

              <div className="mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    resync(f);
                  }}
                  disabled={b || bulkRunning}
                >
                  {b ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  {b ? "Resyncing…" : "Resync now"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
    <FundDetailsModal
      fundCode={selectedFund}
      onClose={() => setSelectedFund(null)}
    />
    </>
  );
}
