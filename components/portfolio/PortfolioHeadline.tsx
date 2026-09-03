import { Card } from "@/components/ui/Card";
import { fmtINR, fmtL, fmtPct, cn } from "@/lib/utils";
import type { PortfolioHeadline as PortfolioHeadlineData } from "@/lib/queries";

/**
 * Portfolio-level headline strip — the "what am I looking at?" summary
 * that sits at the very top of the Portfolio page.
 *
 * Layout intentionally mirrors the Overview page's HeadlineNW so the
 * user builds one mental model:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  ₹38.54 L        +₹1.38 L (+3.72%)      +₹4.5K (+0.12%) 1D  │
 *   │  current           total gain              today             │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Hero (left) is the total MF current value in lakhs. Middle chip is
 * lifetime gain in green/red. Right chip is 1D — null when no fund has
 * a persisted nav_prev yet (fresh install before first refresh cycle).
 *
 * We do NOT include NPS/EPF here because this is the "MF portfolio"
 * page — that stuff has its own top-of-Overview treatment.
 */
export function PortfolioHeadline({ data }: { data: PortfolioHeadlineData }) {
  // MF hero return (inline). The "Total gain" / "1D" chips below fold in
  // International so they reconcile with both value heroes shown.
  const mfGainPositive = data.gainInr >= 0;
  const mfGainColor = mfGainPositive
    ? "text-[hsl(var(--success))]"
    : "text-[hsl(var(--danger))]";

  const totalGainInr = data.totalGainInr ?? data.gainInr;
  const totalGainPct = data.totalGainPct ?? data.gainPct;
  const totalInvested = data.totalInvested ?? data.invested;
  const gainPositive = totalGainInr >= 0;
  const gainColor = gainPositive
    ? "text-[hsl(var(--success))]"
    : "text-[hsl(var(--danger))]";

  const oneDayInr = data.totalOneDayInr ?? data.oneDayInr;
  const oneDayPct = data.totalOneDayPct ?? data.oneDayPct;
  const oneDayPositive = (oneDayInr ?? 0) >= 0;
  const oneDayColor = oneDayPositive
    ? "text-[hsl(var(--success))]"
    : "text-[hsl(var(--danger))]";

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        {/* Hero — total MF current value */}
        <div className="flex flex-col">
          <span className="kicker mb-1">MF current value</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
              {fmtL(data.current)}
            </span>
            <span
              className={cn("text-xs font-medium tabular-nums", mfGainColor)}
            >
              {fmtPct(data.gainPct, { sign: true })}
            </span>
            <span className="text-xs text-muted-foreground">
              across {data.fundCount} funds
            </span>
          </div>
        </div>

        {/* International — separate asset class shown as a peer hero so the
            headline reflects everything the allocation donut counts. */}
        {data.intlValue != null && data.intlValue > 0 && (
          <div className="flex flex-col">
            <span className="kicker mb-1">International</span>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
                {fmtL(data.intlValue)}
              </span>
              <span
                className={cn(
                  "text-xs font-medium tabular-nums",
                  (data.intlGainInr ?? 0) >= 0
                    ? "text-[hsl(var(--success))]"
                    : "text-[hsl(var(--danger))]"
                )}
              >
                {fmtPct(data.intlGainPct ?? 0, { sign: true })}
              </span>
            </div>
          </div>
        )}

        {/* Total gain chip — MF + International combined */}
        <ChipGroup label="Total gain">
          <div className={cn("flex items-baseline gap-2 tabular-nums", gainColor)}>
            <span className="text-lg font-semibold sm:text-xl">
              {gainPositive ? "+" : ""}
              {fmtINR(totalGainInr)}
            </span>
            <span className="text-sm font-medium">
              ({fmtPct(totalGainPct, { sign: true })})
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            invested {fmtL(totalInvested)}
          </span>
        </ChipGroup>

        {/* 1D change chip — MF + International; hidden until a nav_prev baseline exists */}
        {oneDayInr != null && (
          <ChipGroup label="1D">
            <div
              className={cn(
                "flex items-baseline gap-2 tabular-nums",
                oneDayColor
              )}
            >
              <span className="text-lg font-semibold sm:text-xl">
                {oneDayPositive ? "+" : ""}
                {fmtINR(oneDayInr)}
              </span>
              {oneDayPct != null && (
                <span className="text-sm font-medium">
                  ({fmtPct(oneDayPct, { sign: true })})
                </span>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground">
              from yesterday&apos;s close
            </span>
          </ChipGroup>
        )}
      </div>
    </Card>
  );
}

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="kicker mb-1">{label}</span>
      {children}
    </div>
  );
}
