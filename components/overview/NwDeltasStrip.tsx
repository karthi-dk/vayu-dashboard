import { cn, fmtCompactINR, fmtDateShort } from "@/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";
import type { NwDelta } from "@/lib/queries";

/**
 * Row of period chips (1W / 1M / 3M / YTD / 1Y / ALL) shown just under the
 * headline net-worth value. The 1D chip is intentionally omitted here —
 * it's rendered inline with the headline number, where it stays visually
 * "hero" because 1D is the most common thing users glance at.
 *
 * Chips only appear when the underlying history has an anchor row for
 * that period. Fresh installs will start with just [ALL, ~few days] and
 * gain more chips organically as history accumulates.
 */
export function NwDeltasStrip({ deltas }: { deltas: NwDelta[] }) {
  const chips = deltas.filter((d) => d.period !== "1D");
  if (chips.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {chips.map((d) => (
        <DeltaChip key={d.period} delta={d} />
      ))}
    </div>
  );
}

function DeltaChip({ delta }: { delta: NwDelta }) {
  const positive = delta.deltaInr >= 0;
  const tooltipContent = (
    <div>
      <div className="font-semibold">{delta.period} change</div>
      <div className="mt-1 text-muted-foreground">
        Since {fmtDateShort(delta.refDate)} ({delta.daysActual}d ago)
      </div>
      <div className="mt-1 tabular-nums">
        {positive ? "+" : ""}
        {fmtCompactINR(delta.deltaInr)} · {positive ? "+" : ""}
        {delta.returnPct != null ? delta.returnPct.toFixed(2) : "—"}%
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        tabIndex={0}
        className="inline-flex items-baseline gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 py-1 text-[11px] tabular-nums outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium text-muted-foreground">{delta.period}</span>
        <span
          className={cn(
            "font-semibold",
            positive ? "text-[hsl(var(--success))]" : "text-[hsl(var(--danger))]"
          )}
        >
          {fmtCompactINR(delta.deltaInr, { sign: true })}
        </span>
        <span className="text-[10px] text-muted-foreground/80">
          {positive ? "+" : ""}
          {delta.returnPct != null ? delta.returnPct.toFixed(1) : "—"}%
        </span>
      </span>
    </Tooltip>
  );
}
