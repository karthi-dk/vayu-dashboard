import { TrendingUp, TrendingDown } from "lucide-react";
import { cn, fmtDateShort, fmtINR, splitL } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";
import { NwDeltasStrip } from "@/components/overview/NwDeltasStrip";
import type { NwDelta, NwRow } from "@/lib/queries";

export function HeadlineNW({
  latest,
  prev,
  deltas = [],
}: {
  latest: NwRow | null;
  prev: NwRow | null;
  deltas?: NwDelta[];
}) {
  if (!latest) {
    return (
      <div>
        <div className="kicker mb-3">Total net worth</div>
        <h1 className="text-4xl font-bold text-muted-foreground">
          No data yet
        </h1>
        <p className="kicker mt-3">
          Run daily_update.py or paste Groww JSON to populate nw_daily
        </p>
      </div>
    );
  }

  // Headline 1D = sum of per-source contributions since `prev`
  // ----------------------------------------------------------
  // Per-source breakdown:
  //   MF  → Groww's oneDayReturnValue (latest.mf_1d_change_inr) — a
  //         NAV-derived, deposit-immune 1D. Auto-refilled by
  //         recomputeNwDaily from fund_holdings.one_day_change_inr on
  //         every write path (see lib/recomputeNwDaily.ts docstring).
  //   NPS → stored/derived nps_1d_change_inr — Σ units × ΔNAV per
  //         scheme, computed by refresh-nps-nav on rotation days and
  //         auto-derived by recomputeNwDaily on log-write days from
  //         nps_state's *_nav_prev columns. Also deposit-immune.
  //   EPF → snapshot diff — usually ₹0 (EPF is a step-change asset:
  //         payroll and interest credits landing on discrete days
  //         recorded via the /credits ledger). On credit-event days
  //         the EPF component correctly spikes into the headline so
  //         the total NW change isn't silently understated.
  //
  // Why we DON'T use `latest.total_nw − prev.total_nw`:
  //   (a) Groww's MF 1D and the MF snapshot diff diverge by ~₹1-2K/day
  //       due to NAV publish timing lag — Groww's number is the source
  //       of truth for the MF card, so the headline must include it.
  //   (b) Snapshot diff on `nps_value` gets contaminated by any NPS
  //       payroll/contribution credit logged via /credits (which grows
  //       nps_state.units → grows today's nps_value), silently counting
  //       cash-in as market gain. The stored 1D chip is deposit-immune.
  //
  // Fresh-install fallback: if either chip hasn't been persisted yet
  // (DB pre-first-sync), the corresponding component transparently
  // falls back to snapshot diff for that component. On established
  // installs both chips are always present after any write path runs.
  const mfChipInr = latest.mf_1d_change_inr;
  const mfComponent =
    mfChipInr != null ? mfChipInr : prev ? latest.mf_value - prev.mf_value : 0;
  const npsChipInr = latest.nps_1d_change_inr;
  const npsComponent =
    npsChipInr != null
      ? npsChipInr
      : prev
        ? latest.nps_value - prev.nps_value
        : 0;
  const epfComponent = prev ? latest.epf_estimate - prev.epf_estimate : 0;
  const deltaInr: number | null =
    prev || mfChipInr != null || npsChipInr != null
      ? mfComponent + npsComponent + epfComponent
      : null;
  // Percentage denominator: use total_nw as the base since deltaInr sums
  // across all three components. When prev is null (first snapshot ever
  // but Groww chip is present) we can't compute a meaningful %.
  const deltaPct =
    deltaInr != null && prev && prev.total_nw > 0
      ? (deltaInr / prev.total_nw) * 100
      : null;
  const positive = (deltaInr ?? 0) >= 0;
  const { rupees, unit } = splitL(latest.total_nw);

  const asOfLabel = new Date(latest.date)
    .toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    })
    .toUpperCase();
  const prevDateLabel = prev ? fmtDateShort(prev.date) : null;

  return (
    <div>
      <div className="kicker mb-3">Total net worth</div>
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
          {rupees}
          <span className="ml-1 text-2xl font-semibold text-muted-foreground sm:text-3xl md:text-4xl">
            {unit}
          </span>
        </h1>
        {deltaInr != null && (
          <Tooltip
            content={
              mfChipInr != null
                ? `Change since ${prevDateLabel ?? "prev"}: MF (Groww 1D) + NPS snapshot diff + EPF snapshot diff. EPF is usually flat (payroll credits monthly, interest annually) — it only contributes on step-change days.`
                : `Sum of snapshot diffs since ${prevDateLabel ?? "prev"}. MF will switch to Groww's 1D after next sync.`
            }
          >
            <div
              tabIndex={0}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                positive
                  ? "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]"
                  : "bg-[hsl(var(--danger)/0.15)] text-[hsl(var(--danger))]"
              )}
            >
              {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              <span>
                {positive ? "+" : ""}
                {fmtINR(deltaInr)}
                {deltaPct != null && (
                  <>
                    {" "}
                    {positive ? "+" : ""}
                    {deltaPct.toFixed(2)}%
                  </>
                )}
              </span>
            </div>
          </Tooltip>
        )}
      </div>
      <NwDeltasStrip deltas={deltas} />
      <p className="kicker mt-3">
        As of {asOfLabel}
        {!prev && (
          <span className="ml-2 rounded bg-muted/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">
            First snapshot · delta available tomorrow
          </span>
        )}
      </p>
    </div>
  );
}
