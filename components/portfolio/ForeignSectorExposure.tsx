"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Globe, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn, fmtL } from "@/lib/utils";
import type { ForeignSector } from "@/lib/queries";
import { ForeignHoldingsTable } from "@/components/portfolio/ForeignHoldingsTable";

/** Deterministic color per sector name (same hash as the NSE card). */
function sectorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 65%)`;
}

function SectorTile({
  sector,
  pct,
  companies,
  variant,
  onClick,
}: {
  sector: string;
  pct: number;
  companies: number;
  variant: "primary" | "secondary";
  onClick: () => void;
}) {
  const color = sectorColor(sector);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${sector} foreign sector drill-down`}
      className={cn(
        "group relative w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/20 p-4 text-left transition-colors hover:border-border/80 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]",
        variant === "primary" ? "min-h-[110px]" : "min-h-[92px]"
      )}
    >
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: color }}
      />
      <ChevronRight
        size={12}
        className="absolute right-3 top-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
      <div className="flex flex-col gap-1">
        <div
          className={cn(
            "font-semibold text-foreground",
            variant === "primary" ? "text-sm" : "text-xs"
          )}
        >
          {sector}
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
 * Foreign sector exposure card
 * ============================
 *
 * Mirrors the NSE Sector-exposure card, but for your overseas equity —
 * every foreign holding across ICICI Nasdaq, HDFC DM and domestic funds'
 * US slices (e.g. PPFAS), bucketed by its GICS sector. Percentages are of
 * the foreign book (they sum to ~100%), so this reads as "how my foreign
 * money is spread by sector" independent of the India-heavy MF total. Any
 * future foreign fund flows in automatically (it's driven by the master
 * region tag, not a hard-coded fund list).
 */
export function ForeignSectorExposure({
  sectors,
}: {
  sectors: ForeignSector[];
}) {
  const [selected, setSelected] = useState<ForeignSector | null>(null);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!sectors.length) return null;

  const primary = sectors.slice(0, 3);
  const secondary = sectors.slice(3);

  return (
    <>
      <Card className="p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5">
              <Globe size={13} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">
                Foreign sector exposure
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your overseas equity (ICICI Nasdaq, HDFC DM &amp; domestic funds&apos;
              US slices) by GICS sector · % of your foreign book · click any
              sector to see the companies inside
            </p>
          </div>
          <Badge variant="muted">GICS classification</Badge>
        </div>

        {primary.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {primary.map((s) => (
              <SectorTile
                key={s.sector}
                sector={s.sector}
                pct={s.pct_of_foreign}
                companies={s.n_companies}
                variant="primary"
                onClick={() => setSelected(s)}
              />
            ))}
          </div>
        )}

        {secondary.length > 0 && (
          <div
            className={cn(
              "mt-3 grid gap-3 md:grid-cols-6",
              secondary.length < 4 ? "grid-cols-2" : "grid-cols-3"
            )}
          >
            {secondary.map((s) => (
              <SectorTile
                key={s.sector}
                sector={s.sector}
                pct={s.pct_of_foreign}
                companies={s.n_companies}
                variant="secondary"
                onClick={() => setSelected(s)}
              />
            ))}
          </div>
        )}
      </Card>

      {selected && (
        <SectorModal sector={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function SectorModal({
  sector,
  onClose,
}: {
  sector: ForeignSector;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {sector.sector}
            </h3>
            <p className="mt-0.5 kicker">
              {sector.pct_of_foreign.toFixed(1)}% of foreign ·{" "}
              {fmtL(sector.effective_inr)} · {sector.n_companies}{" "}
              {sector.n_companies === 1 ? "holding" : "holdings"}
              {sector.n_companies > sector.stocks.length &&
                ` · top ${sector.stocks.length}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto">
          <ForeignHoldingsTable
            stocks={sector.stocks}
            pctLabel="% of sector"
            pctFor={(s) =>
              sector.effective_inr > 0
                ? (s.effective_inr / sector.effective_inr) * 100
                : 0
            }
          />
        </div>
      </div>
    </div>
  );
}
