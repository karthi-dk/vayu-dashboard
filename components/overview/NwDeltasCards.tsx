import { cn, fmtCompactINR, fmtDateShort } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";
import type { NwDelta } from "@/lib/queries";

/**
 * Net-worth change grid shown under the headline value. One compact card
 * per period (1M → ALL), splitting each window's net change into the money
 * you ADDED (deposits) vs market GROWTH — shown both as a proportional bar
 * and as the two figures below it — with a return % on the growth so a long
 * window that's mostly contributions doesn't read like a huge return. The
 * 1D and 1W windows are omitted (1D is the headline's hero number; 1W is
 * too noisy to be decision-useful).
 *
 * Return = growth ÷ capital deployed (starting balance + deposits), not
 * annualised; the ALL card measures from the ₹0 inception point, so its
 * return is growth ÷ lifetime contributions.
 */

const PERIOD_TITLE: Record<string, string> = {
  "1W": "Past week",
  "1M": "Past month",
  "3M": "Past 3 months",
  "6M": "Past 6 months",
  YTD: "Year to date",
  "1Y": "Past year",
  "3Y": "Past 3 years",
  "5Y": "Past 5 years",
  ALL: "Since inception",
};

export function NwDeltasCards({ deltas }: { deltas: NwDelta[] }) {
  const rows = deltas.filter((d) => d.period !== "1D" && d.period !== "1W");
  if (rows.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/50" /> added
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-[hsl(var(--success))]" /> growth
        </span>
        <Tooltip
          content={
            <span>
              Return = market growth ÷ capital deployed (starting balance +
              deposits). Not annualised.
            </span>
          }
        >
          <span className="ml-auto cursor-help underline decoration-dotted underline-offset-2">
            what&apos;s the return %?
          </span>
        </Tooltip>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {rows.map((d) => (
          <DeltaCard key={d.period} d={d} />
        ))}
      </div>
    </div>
  );
}

function DeltaCard({ d }: { d: NwDelta }) {
  const hasDeposits = Math.abs(d.depositsInr) >= 100;
  const dep = Math.abs(d.depositsInr);
  const grow = Math.abs(d.growthInr);
  const depPct = dep + grow > 0 ? Math.round((dep / (dep + grow)) * 100) : 100;

  return (
    <div className="rounded-md border border-border/60 bg-background/40 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <Tooltip
          content={
            <span>
              {PERIOD_TITLE[d.period] ?? d.period} · since{" "}
              {fmtDateShort(d.refDate)} ({d.daysActual}d ago)
            </span>
          }
        >
          <span className="cursor-help text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {d.period}
          </span>
        </Tooltip>
        <span
          className={cn(
            "text-[10px] font-semibold tabular-nums",
            d.returnPct == null ? "text-muted-foreground/60" : signClass(d.returnPct)
          )}
        >
          {d.returnPct == null
            ? "—"
            : `${d.returnPct >= 0 ? "+" : "−"}${Math.abs(d.returnPct).toFixed(1)}%`}
        </span>
      </div>

      <div className={cn("mt-0.5 text-[15px] font-bold leading-tight tabular-nums", signClass(d.deltaInr))}>
        {fmtCompactINR(d.deltaInr, { sign: true })}
      </div>

      <div className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-muted/40">
        <div style={{ width: `${depPct}%` }} className="bg-muted-foreground/50" />
        <div style={{ width: `${100 - depPct}%` }} className={signBg(d.growthInr)} />
      </div>

      <div className="mt-1 flex justify-between text-[10px] tabular-nums">
        <span className="text-muted-foreground">
          {hasDeposits ? `+${fmtCompactINR(d.depositsInr)} in` : "—"}
        </span>
        <span className={signClass(d.growthInr)}>
          {fmtCompactINR(d.growthInr, { sign: true })}
        </span>
      </div>
    </div>
  );
}

function signClass(v: number): string {
  return v >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]";
}

function signBg(v: number): string {
  return v >= 0 ? "bg-[hsl(var(--success))]" : "bg-[hsl(var(--danger))]";
}
