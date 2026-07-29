import { Card } from "@/components/ui/Card";
import { fmtDateShort } from "@/lib/utils";
import type { IndexLevelRow } from "@/lib/queries";

/**
 * Index highs — compact "how far off the peak" strip
 * =====================================================
 *
 * Small reference table for the six tracked market indices (Nifty 50,
 * Next 50, Midcap 150, Smallcap 250, Nasdaq 100, S&P 500): current
 * level, today's move, and % below each of 3-month-high / 52-week-high /
 * all-time-high (ordered by recency of the reference window — nearest
 * first, farthest last, mirroring how you'd read a drawdown timeline).
 * Data comes from `index_levels`, populated by a manual refresh on
 * /sync (RefreshIndexLevelsCard → /api/refresh-index-levels) or the
 * inline auto-refresh on page load. See lib/indexLevels/yahooClient.ts
 * for the data source and the real ticker-mapping gotchas that went
 * into getting this right.
 *
 * All three "vs X high" columns are computed off the SAME close-price
 * series per index (not mixed conventions), so 0.00% consistently means
 * "today's close IS that reference high" across every column.
 */

const DISPLAY_ORDER = [
  "N50",
  "NN50",
  "MID150",
  "SMALL250",
  "NASDAQ100",
  "SP500",
] as const;

// Categorical swatch per index — purely a visual-identity accent (not
// data-driven), so each row is instantly recognizable at a glance
// without reading the label first. Hardcoded absolute hues rather than
// the theme's semantic CSS vars (--success/--warning/--danger) because
// these carry no meaning beyond "this dot = this index" and need to
// stay visually distinct from the severity colors used in PctCell
// below — reusing green/amber/red here would make a Nifty 50 dot look
// like a bad-performance signal.
const SWATCH: Record<string, string> = {
  N50: "#38bdf8", // sky
  NN50: "#818cf8", // indigo
  MID150: "#2dd4bf", // teal
  SMALL250: "#fb923c", // orange
  NASDAQ100: "#e879f9", // fuchsia
  SP500: "#34d399", // emerald
};

function fmtLevel(level: number, currency: "INR" | "USD"): string {
  return level.toLocaleString(currency === "USD" ? "en-US" : "en-IN", {
    maximumFractionDigits: 0,
  });
}

function pctOff(current: number, ref: number): number {
  if (ref <= 0) return 0;
  return ((current - ref) / ref) * 100;
}

/**
 * Today's % move for an index, colored by direction:
 *   • green  — up (positive move today)
 *   • red    — down (negative move today)
 *   • muted  — flat (essentially 0) or previous close unavailable
 *
 * Renders "—" when previous_close is null (pre-2026-07-24 rows that
 * haven't been refreshed yet, or a data-gap edge case).
 */
function TodayCell({
  current,
  previous,
}: {
  current: number;
  previous: number | null;
}) {
  if (previous == null || previous <= 0) {
    return (
      <span className="inline-block min-w-[3.25rem] rounded bg-muted/30 px-1.5 py-0.5 text-right font-medium text-muted-foreground">
        —
      </span>
    );
  }
  const pct = ((current - previous) / previous) * 100;
  // Small epsilon so a 0.00% intraday reading (no bar rollover yet)
  // doesn't render as a color signal. Same epsilon convention as
  // PctCell's atHigh check.
  const flat = Math.abs(pct) < 0.005;
  const palette = flat
    ? "bg-muted/40 text-muted-foreground"
    : pct > 0
      ? "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]"
      : "bg-[hsl(var(--danger)/0.15)] text-[hsl(var(--danger))]";
  const sign = flat ? "" : pct > 0 ? "+" : "";
  return (
    <span
      className={`inline-block min-w-[3.25rem] rounded px-1.5 py-0.5 text-right font-semibold ${palette}`}
    >
      {flat ? "0.0%" : `${sign}${pct.toFixed(2)}%`}
    </span>
  );
}

/**
 * Severity-tinted badge for a "% below reference high" value. Three
 * tiers mapped onto the app's existing success/warning/danger palette
 * (same vars PulseDot/StatCard use elsewhere) so a glance at the color
 * alone tells you how far a given index has pulled back:
 *   • ≥ -2%   success (green)  — at or essentially at that high
 *   • -2%..-8% warning (amber) — a normal, unremarkable pullback
 *   • < -8%   danger (red)    — a deeper drawdown from that reference
 * Thresholds are a judgment call, not a standard — tuned so a garden-
 * variety 3-5% dip doesn't read as alarming red, but a double-digit
 * drawdown does.
 */
function PctCell({ pct }: { pct: number }) {
  // pct can never exceed 0 for a window that includes "today" among its
  // own candidates (today's close is one of the points the max was
  // taken over) — 0.00% means today's close IS that reference high.
  // Small epsilon guards against float rounding showing "-0.0%".
  const atHigh = pct >= -0.005;
  const tier: "success" | "warning" | "danger" = atHigh
    ? "success"
    : pct >= -8
      ? "warning"
      : "danger";
  const palette = {
    success: "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]",
    warning: "bg-[hsl(var(--warning)/0.15)] text-[hsl(var(--warning))]",
    danger: "bg-[hsl(var(--danger)/0.15)] text-[hsl(var(--danger))]",
  }[tier];
  return (
    <span
      className={`inline-block min-w-[3.25rem] rounded px-1.5 py-0.5 text-right font-semibold ${palette}`}
    >
      {atHigh ? "0.0%" : `${pct.toFixed(1)}%`}
    </span>
  );
}

export function IndexHighsCard({ rows }: { rows: IndexLevelRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-foreground">Index highs</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Not refreshed yet — click Refresh on the{" "}
          <a href="/sync" className="underline hover:text-foreground">
            Sync
          </a>{" "}
          page to pull All-Time-High / 52-week / 3-month highs for Nifty 50,
          Next 50, Midcap 150, Smallcap 250, Nasdaq 100 &amp; S&amp;P 500.
        </p>
      </Card>
    );
  }

  const byCode = new Map(rows.map((r) => [r.index_code, r]));
  const ordered = DISPLAY_ORDER.map((c) => byCode.get(c)).filter(
    (r): r is IndexLevelRow => r != null
  );

  const updatedAt = rows.reduce<string | null>(
    (max, r) => (max === null || r.updated_at > max ? r.updated_at : max),
    null
  );

  // Show "24 Jul, 13:57" (IST) rather than just "24 Jul", so the eye
  // can actually SEE that a reload triggered a refresh — otherwise every
  // reload within the same calendar day shows the identical "Updated
  // 24 Jul" label and the widget looks static even when it isn't. Time
  // zone is pinned to IST because that's the trading calendar users
  // are tracking; a server render in a different TZ would otherwise
  // silently drift.
  const updatedLabel = (() => {
    if (!updatedAt) return "—";
    const d = new Date(updatedAt);
    if (Number.isNaN(d.getTime())) return "—";
    const datePart = d.toLocaleDateString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
    });
    const timePart = d.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${datePart}, ${timePart}`;
  })();

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Index highs</h2>
          <p className="mt-0.5 kicker">
            Today's move · % below 3m / 52w / all-time closing high
          </p>
        </div>
        <span
          className="kicker whitespace-nowrap"
          title="Auto-refreshes on page load when >60 s stale. Manual refresh from the nav Refresh menu or /sync. Yahoo Finance daily closes."
        >
          Updated {updatedLabel}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase text-muted-foreground">
              <th className="pb-1.5 pr-2 text-left font-medium">Index</th>
              <th className="pb-1.5 pr-2 text-right font-medium">Current</th>
              <th className="pb-1.5 pr-2 text-right font-medium">Today</th>
              <th className="pb-1.5 pr-2 text-right font-medium">3m</th>
              <th className="pb-1.5 pr-2 text-right font-medium">52w</th>
              <th className="pb-1.5 text-right font-medium">ATH</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => {
              const offAth = pctOff(r.current_level, r.ath_level);
              const off52w = pctOff(r.current_level, r.high_52w_level);
              const off3m = pctOff(r.current_level, r.high_3m_level);
              return (
                <tr key={r.index_code} className="border-t border-border/60">
                  <td className="py-1.5 pr-2 font-medium text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: SWATCH[r.index_code] ?? "#94a3b8" }}
                      />
                      {r.display_name}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-foreground">
                    {fmtLevel(r.current_level, r.currency)}
                  </td>
                  <td
                    className="py-1.5 pr-2 text-right tabular-nums"
                    title={
                      r.previous_close != null
                        ? `Previous close ${fmtLevel(r.previous_close, r.currency)}${
                            r.previous_close_date
                              ? ` on ${fmtDateShort(r.previous_close_date)}`
                              : ""
                          }`
                        : "Previous close unavailable — refresh from /sync to populate"
                    }
                  >
                    <TodayCell
                      current={r.current_level}
                      previous={r.previous_close}
                    />
                  </td>
                  <td
                    className="py-1.5 pr-2 text-right tabular-nums"
                    title={`3-month high ${fmtLevel(r.high_3m_level, r.currency)} on ${fmtDateShort(r.high_3m_date)}`}
                  >
                    <PctCell pct={off3m} />
                  </td>
                  <td
                    className="py-1.5 pr-2 text-right tabular-nums"
                    title={`52-week high ${fmtLevel(r.high_52w_level, r.currency)} on ${fmtDateShort(r.high_52w_date)}`}
                  >
                    <PctCell pct={off52w} />
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    title={`ATH ${fmtLevel(r.ath_level, r.currency)} on ${fmtDateShort(r.ath_date)}`}
                  >
                    <PctCell pct={offAth} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
