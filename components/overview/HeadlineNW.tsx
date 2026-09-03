import { TrendingUp, TrendingDown } from "lucide-react";
import { cn, fmtDateShort, fmtINR, splitL } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";
import { NwDeltasCards } from "@/components/overview/NwDeltasCards";
import type { NwDelta, NwRow, RetirementCredit } from "@/lib/queries";

export function HeadlineNW({
  latest,
  prev,
  deltas = [],
  credits = [],
}: {
  latest: NwRow | null;
  prev: NwRow | null;
  deltas?: NwDelta[];
  credits?: RetirementCredit[];
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
  //   EPF → interest credits from the /credits ledger dated in the
  //         window — deposit-immune, matching MF/NPS. EPF has no daily
  //         market move; its only growth is interest (usually annual),
  //         so payroll credits (money-in) must NOT spike the headline.
  //         Reading the ledger's 'interest' events instead of an
  //         epf_estimate snapshot diff also makes this robust to
  //         backdated payroll credits, whose balance step lands on the
  //         log-day nw_daily row rather than on the credit_date.
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
  // International 1D — stored intl_1d_change_inr (Σ intl one_day_change_inr,
  // deposit-immune), else snapshot diff of intl_value.
  const intlChipInr = latest.intl_1d_change_inr;
  const intlComponent =
    intlChipInr != null
      ? intlChipInr
      : prev
        ? (latest.intl_value ?? 0) - (prev.intl_value ?? 0)
        : 0;
  const epfComponent =
    prev != null
      ? credits
          .filter(
            (c) =>
              c.source === "EPF" &&
              c.credit_type === "interest" &&
              c.credit_date > prev.date &&
              c.credit_date <= latest.date
          )
          .reduce((sum, c) => sum + Number(c.amount_inr), 0)
      : 0;
  const deltaInr: number | null =
    prev || mfChipInr != null || npsChipInr != null || intlChipInr != null
      ? mfComponent + npsComponent + epfComponent + intlComponent
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
                ? `Change since ${prevDateLabel ?? "prev"}: MF (Groww 1D) + International + NPS 1D + EPF interest — deposit-immune, so payroll/contributions never count as growth. EPF only moves here when interest is credited.`
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
      <NwDeltasCards deltas={deltas} />
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
