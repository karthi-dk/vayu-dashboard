import { Card } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtL } from "@/lib/utils";
import type { LiquiditySplit } from "@/lib/queries";

/**
 * Liquidity card — Liquid (touchable "tomorrow") vs Locked (age-gated).
 *
 * Structure intentionally mirrors EquityDebtCard so the two cards read as
 * "siblings" on the Overview page:
 *   Row 1: header + ratio pill
 *   Row 2: liquid value (left) / locked value (right)
 *   Row 3: split bar
 * The mirrored layout is deliberate — users only need to learn the pattern
 * once and then can quickly scan multiple two-bucket breakdowns.
 *
 * Colors:
 *   Liquid → --liquid (cyan/sky) — semantically "flowing, accessible"
 *   Locked → --locked (warm sepia) — semantically "earthy, reserved for
 *            later". Retirement lock-in is a feature not a warning, so
 *            the hue is warm/inviting rather than gray/muted.
 * Both tokens are defined in globals.css and swap correctly across
 * light/dark themes. They are intentionally distinct from --primary
 * (used by MF card / Equity bucket) and --warning (used by EPF card /
 * Debt bucket) so LiquidityCard doesn't visually collide with the
 * EquityDebtCard sitting next to it.
 *
 * If no snapshot exists yet (empty install) we render an empty state.
 */
export function LiquidityCard({ split }: { split: LiquiditySplit | null }) {
  if (!split) {
    return (
      <Card className="p-4 sm:p-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Liquidity</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Sync your portfolio to see the liquid : locked split.
        </p>
      </Card>
    );
  }

  const { liquid, locked, liquidPct, lockedPct, breakdown } = split;

  // Same normalization trick as EquityDebtCard: round the primary side
  // and derive the counterpart as (100 - x) so the ratio pill always
  // sums to exactly 100.
  const liquidRounded = Math.round(liquidPct);
  const lockedRounded = 100 - liquidRounded;

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Liquidity</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Accessible now vs locked till retirement
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground">
          {liquidRounded} : {lockedRounded}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <BucketRow
          color="hsl(var(--liquid))"
          label="Liquid"
          value={liquid}
          pct={liquidPct}
          tooltip={
            <div className="space-y-0.5">
              <Line label="Mutual funds" value={breakdown.mf} />
              <Line label="International" value={breakdown.intl} />
              <div className="mt-1 text-[10px] text-muted-foreground/70">
                Sellable any market day · T+1 credit
              </div>
            </div>
          }
        />
        <BucketRow
          color="hsl(var(--locked))"
          label="Locked"
          value={locked}
          pct={lockedPct}
          align="right"
          tooltip={
            <div className="space-y-0.5">
              <Line label="NPS (till age 60)" value={breakdown.nps} />
              <Line label="EPF (till age 58)" value={breakdown.epf} />
              <div className="mt-1 text-[10px] text-muted-foreground/70">
                Partial withdrawals allowed for medical, housing, etc.
              </div>
            </div>
          }
        />
      </div>

      <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full"
          style={{
            width: `${Math.max(liquidPct, 0.5)}%`,
            background: "hsl(var(--liquid))",
          }}
          aria-label={`Liquid ${liquidRounded}%`}
        />
        <div
          className="h-full"
          style={{
            width: `${Math.max(lockedPct, 0.5)}%`,
            background: "hsl(var(--locked))",
          }}
          aria-label={`Locked ${lockedRounded}%`}
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
