import { Card } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtL } from "@/lib/utils";
import type { AssetSplit } from "@/lib/queries";

/**
 * Asset Allocation card — Equity vs Debt split across MF + NPS + EPF.
 *
 * Layout (all inside one Card):
 *   Row 1: header ("ASSET ALLOCATION") + ratio pill ("70:30")
 *   Row 2: left = equity value + %, right = debt value + %
 *   Row 3: single horizontal split bar
 *   Row 4: hover-explained sub-line for what's inside each bucket
 *
 * Colors match the semantic palette used elsewhere:
 *   Equity → primary (violet) — same as MF card
 *   Debt   → warning (amber)  — same as EPF card, associates "steady"
 *
 * If assetSplit is null (no fund data yet on a fresh install), we render
 * an empty-state instead of NaN percentages. Bar rendering guards against
 * pct = 0 or 100 with min-width so hairline bars still register visually.
 */
export function EquityDebtCard({ split }: { split: AssetSplit | null }) {
  if (!split) {
    return (
      <Card className="p-4 sm:p-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Asset Allocation</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Sync your Groww portfolio to see the equity : debt split.
        </p>
      </Card>
    );
  }

  const { totalEquity, totalDebt, equityPct, debtPct, breakdown } = split;

  // Ratio pill: round each side and normalize the sum to 100 so the pill
  // always reads as an integer pair. Occasionally 70.4 + 29.6 rounds to
  // "70 : 30" (100 total, ok) but 69.7 + 30.3 could round to "70 : 30"
  // giving a clean pair; and 70.5 + 29.5 → "71 : 30" (101 total) needs a
  // fix. We anchor the debt side to (100 - equityRounded) so the sum is
  // always exactly 100.
  const equityRounded = Math.round(equityPct);
  const debtRounded = 100 - equityRounded;

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Asset Allocation</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Equity vs Debt across MF, NPS &amp; EPF
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground">
          {equityRounded} : {debtRounded}
        </div>
      </div>

      {/* Stack vertically on mobile — a two-column layout at <400px squishes
          the values ("₹40.73L") uncomfortably close to their labels.
          At sm+ (≥640px) we switch to side-by-side with the Debt column
          right-aligned so the pair reads as a natural "left : right"
          comparison. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BucketRow
          color="hsl(var(--primary))"
          label="Equity"
          value={totalEquity}
          pct={equityPct}
          tooltip={
            <div className="space-y-0.5">
              <Line label="MF equity funds" value={breakdown.mfEquity} />
              <Line label="NPS (Scheme E)" value={breakdown.npsEquity} />
            </div>
          }
        />
        <BucketRow
          color="hsl(var(--warning))"
          label="Debt"
          value={totalDebt}
          pct={debtPct}
          align="right"
          tooltip={
            <div className="space-y-0.5">
              <Line label="MF debt / hybrid" value={breakdown.mfDebt} />
              <Line label="NPS (Schemes C+G)" value={breakdown.npsDebt} />
              <Line label="EPF" value={breakdown.epfDebt} />
            </div>
          }
        />
      </div>

      {/* Horizontal split bar. min-width on each half keeps a hairline
          visible even when one side rounds to ~0-3%. */}
      <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full"
          style={{
            width: `${Math.max(equityPct, 0.5)}%`,
            background: "hsl(var(--primary))",
          }}
          aria-label={`Equity ${equityRounded}%`}
        />
        <div
          className="h-full"
          style={{
            width: `${Math.max(debtPct, 0.5)}%`,
            background: "hsl(var(--warning))",
          }}
          aria-label={`Debt ${debtRounded}%`}
        />
      </div>
    </Card>
  );
}

function BucketRow({
  color,
  label,
  value,
  pct,
  tooltip,
  align = "left",
}: {
  color: string;
  label: string;
  value: number;
  pct: number;
  tooltip: React.ReactNode;
  align?: "left" | "right";
}) {
  // Right-align is disabled below sm (640px) — the parent grid stacks
  // vertically there, and a right-aligned single-column column looks
  // strange floating on the right edge. Above sm it's the second column
  // in a 2-col row and right-aligns to visually complete the pair.
  const rightAtSm = align === "right";
  return (
    <div className={rightAtSm ? "sm:text-right" : ""}>
      <div
        className={`flex items-center gap-1.5 ${
          rightAtSm ? "sm:justify-end" : ""
        }`}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: color }}
        />
        <Tooltip content={tooltip} align={rightAtSm ? "end" : "start"}>
          <span className="text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-4">
            {label}
          </span>
        </Tooltip>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {fmtL(value)}
      </div>
      <div className="text-[11px] text-muted-foreground tabular-nums">
        {pct.toFixed(1)}% of NW
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{fmtL(value)}</span>
    </div>
  );
}
