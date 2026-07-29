"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import type { LookthroughStock, SectorSlice } from "@/lib/queries";
import { SectorDetailModal } from "@/components/portfolio/SectorDetailModal";

/**
 * Deterministic color palette by hashing sector name → hue. Ensures the
 * same sector always gets the same color across page loads and screen
 * sizes. Tuned saturation/lightness give reasonable contrast on both
 * light and dark backgrounds.
 */
function sectorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 65%)`;
}

function SectorTile({
  name,
  pct,
  companies,
  variant,
  onClick,
  disabled,
}: {
  name: string;
  pct: number;
  companies: number;
  variant: "primary" | "secondary";
  onClick: () => void;
  disabled: boolean;
}) {
  const color = sectorColor(name);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={
        disabled
          ? `${name} sector, no drill-down data`
          : `Open ${name} sector drill-down`
      }
      className={cn(
        // Reset button defaults so it matches the original div card.
        "group relative w-full overflow-hidden rounded-lg border border-border bg-muted/20 p-4 text-left",
        // Only give hover affordance when clickable — otherwise stays
        // visually identical to the original static tile.
        !disabled &&
          "cursor-pointer transition-colors hover:border-border/80 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]",
        disabled && "cursor-default opacity-70",
        variant === "primary" ? "min-h-[110px]" : "min-h-[92px]"
      )}
    >
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: color }}
      />
      {/* Chevron only appears on interactive tiles, and fades in on
          hover so the resting state is calm. */}
      {!disabled && (
        <ChevronRight
          size={12}
          className="absolute right-3 top-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      )}
      <div className="flex flex-col gap-1">
        <div
          className={cn(
            "font-semibold text-foreground",
            variant === "primary" ? "text-sm" : "text-xs"
          )}
        >
          {name}
        </div>
        <div className="kicker">
          {companies} {companies === 1 ? "company" : "companies"}
        </div>
        <div
          className={cn(
            "mt-auto pt-2 font-bold text-foreground",
            variant === "primary" ? "text-2xl" : "text-lg"
          )}
        >
          {pct.toFixed(1)}%
        </div>
      </div>
    </button>
  );
}

/**
 * Sector exposure card
 * ====================
 *
 * Tiled grid of all sectors weighted by look-through position size.
 * Top 3 sectors render as larger primary tiles; the rest fill in as
 * secondary tiles.
 *
 * 2026-07-17 addition: every tile is a button that opens
 * `SectorDetailModal` with the full company list for that sector. If
 * a sector has no look-through data (empty stocksBySector bucket),
 * the tile stays visible but is disabled — the sector still appears
 * on the tile grid because the aggregate came from a different code
 * path, but there's nothing to drill into.
 */
export function SectorExposure({
  sectors,
  stocksBySector,
  mfTotal,
}: {
  sectors: SectorSlice[];
  stocksBySector: Record<string, LookthroughStock[]>;
  mfTotal: number;
}) {
  const [selectedSector, setSelectedSector] = useState<string | null>(null);

  if (!sectors.length) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Sector exposure
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          No look-through data available yet. Populate{" "}
          <code className="font-mono">fund_holdings_detail</code> via the
          Sync page.
        </p>
      </Card>
    );
  }

  const primary = sectors.filter((s) => s.tier === "primary");
  const secondary = sectors.filter((s) => s.tier === "secondary");

  return (
    <>
      <Card className="p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Sector exposure
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Weighted by fund value · underlying holding weight · look-through
              · click any sector to see the companies inside
            </p>
          </div>
          <Badge variant="muted">NSE classification</Badge>
        </div>

        {primary.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {primary.map((s) => (
              <SectorTile
                key={s.name}
                {...s}
                variant="primary"
                onClick={() => setSelectedSector(s.name)}
                disabled={(stocksBySector[s.name]?.length ?? 0) === 0}
              />
            ))}
          </div>
        )}

        {secondary.length > 0 && (
          <div
            className={cn(
              "grid gap-3 md:grid-cols-6",
              primary.length ? "mt-3" : "",
              secondary.length < 4 ? "grid-cols-2" : "grid-cols-3"
            )}
          >
            {secondary.map((s) => (
              <SectorTile
                key={s.name}
                {...s}
                variant="secondary"
                onClick={() => setSelectedSector(s.name)}
                disabled={(stocksBySector[s.name]?.length ?? 0) === 0}
              />
            ))}
          </div>
        )}
      </Card>

      <SectorDetailModal
        sector={selectedSector}
        stocks={
          selectedSector ? (stocksBySector[selectedSector] ?? []) : []
        }
        mfTotal={mfTotal}
        onClose={() => setSelectedSector(null)}
      />
    </>
  );
}
