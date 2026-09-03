import { Card } from "@/components/ui/Card";
import { NwDeltasCards } from "@/components/overview/NwDeltasCards";
import { fmtL, fmtCompactINR, fmtDateShort } from "@/lib/utils";
import type { InternationalSummary, NwDelta } from "@/lib/queries";

/**
 * International asset-class detail card. Lists each holding with its INR
 * value + return, and for USD-native funds (HDFC GIFT City) breaks the
 * return into fund (USD-NAV) vs FX components and shows the "exit today"
 * value (redemption-short, exit load applied). Below the holdings sits the
 * INR period-returns grid (same windows as the MF grid), populated from
 * nw_daily.intl_value once the backfill has run.
 */

function pctClass(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  return v >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]";
}
function withSign(v: number): string {
  return v >= 0 ? "+" : "";
}

function Metric({
  label,
  value,
  cls,
}: {
  label: string;
  value: string;
  cls?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`tabular-nums ${cls ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

export function InternationalCard({
  international,
  deltas,
}: {
  international: InternationalSummary | null;
  deltas: NwDelta[];
}) {
  if (!international || international.funds.length === 0) return null;
  const hasGrid = deltas.some((d) => d.period !== "1D");

  return (
    <Card className="p-4 sm:p-5">
      <div className="text-sm font-semibold text-foreground">
        International — holdings &amp; returns
      </div>
      <div className="mt-0.5 kicker">
        USD funds marked at live USD→INR; the INR value floats with the rupee
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {international.funds.map((f) => (
          <div
            key={f.fundCode}
            className="rounded-lg border border-border bg-muted/10 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                {f.fundName}
              </span>
              <span className="text-sm tabular-nums text-foreground">
                {fmtL(f.valueInr)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
              <span className={pctClass(f.gainPct)}>
                {withSign(f.gainPct)}
                {f.gainPct.toFixed(2)}%{" "}
                <span className="opacity-80">
                  ({fmtCompactINR(f.valueInr - f.investedInr, { sign: true })})
                </span>{" "}
                <span className="text-muted-foreground">
                  vs invested {fmtL(f.investedInr)}
                </span>
              </span>
              {f.navDate && (
                <span className="text-muted-foreground">
                  as of {fmtDateShort(f.navDate)}
                </span>
              )}
            </div>

            {f.currency === "USD" && (
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border/60 pt-2 text-xs sm:grid-cols-4">
                <Metric
                  label="USD NAV"
                  value={f.navUsd != null ? `$${f.navUsd.toFixed(4)}` : "—"}
                />
                <Metric
                  label="Fund · USD"
                  value={
                    f.usdReturnPct != null
                      ? `${withSign(f.usdReturnPct)}${f.usdReturnPct.toFixed(2)}%`
                      : "—"
                  }
                  cls={pctClass(f.usdReturnPct)}
                />
                <Metric
                  label={f.fxRate != null ? `FX · ₹${f.fxRate.toFixed(2)}` : "FX"}
                  value={
                    f.fxReturnPct != null
                      ? `${withSign(f.fxReturnPct)}${f.fxReturnPct.toFixed(2)}%`
                      : "—"
                  }
                  cls={pctClass(f.fxReturnPct)}
                />
                <Metric
                  label="Exit today"
                  value={f.exitTodayInr != null ? fmtL(f.exitTodayInr) : "—"}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {hasGrid && (
        <div className="mt-4">
          <div className="text-xs font-semibold text-foreground">
            Period returns (INR)
          </div>
          <NwDeltasCards deltas={deltas} />
        </div>
      )}
    </Card>
  );
}
