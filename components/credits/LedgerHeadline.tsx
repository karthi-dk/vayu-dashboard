import { Card } from "@/components/ui/Card";
import { fmtINR } from "@/lib/utils";

/**
 * Current-month totals across all three savings streams. Rendered as
 * a single quiet strip at the top of the Credits page so the user can
 * see "this month I've put in ₹X" at a glance before scrolling into
 * the detailed logs.
 *
 * Design choices:
 *   • Uses the same "chip in a card" pattern as the Overview
 *     headline — familiar visual language.
 *   • Total is computed here (not passed in) so any future third
 *     source (e.g., FD interest, direct equity) can be added by
 *     dropping a prop into the input; total re-derives.
 *   • Zero values are still rendered (as ₹0). Hiding them would make
 *     the row jitter as data arrives during the month.
 */
export function LedgerHeadline({
  epfInr,
  npsInr,
  mfInr,
  monthLabel,
}: {
  epfInr: number;
  npsInr: number;
  mfInr: number;
  /** e.g., "July 2026" — passed in so we don't render dates in a
   *  server component using the browser's timezone. */
  monthLabel: string;
}) {
  const total = epfInr + npsInr + mfInr;
  // MF first — matches the page's section order (MF log above the
  // retirement log) because MF is the more active stream (daily /
  // weekly), whereas EPF and NPS update ~monthly.
  const chips: { label: string; value: number; tone: string }[] = [
    { label: "MF", value: mfInr, tone: "text-[hsl(150_65%_65%)]" },
    { label: "EPF", value: epfInr, tone: "text-[hsl(var(--primary))]" },
    { label: "NPS", value: npsInr, tone: "text-[hsl(280_65%_75%)]" },
  ];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            This month · {monthLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {chips.map((c) => (
            <div
              key={c.label}
              className="flex items-baseline gap-1.5"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {c.label}
              </span>
              <span
                className={`text-sm font-semibold tabular-nums ${c.tone}`}
              >
                {fmtINR(c.value)}
              </span>
            </div>
          ))}
          <div className="ml-2 flex items-baseline gap-1.5 border-l border-border pl-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Total
            </span>
            <span className="text-lg font-bold tabular-nums text-foreground">
              {fmtINR(total)}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
