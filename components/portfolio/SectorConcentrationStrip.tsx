"use client";

import { AlertTriangle, AlertCircle, Info, Shield } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import type {
  SectorConcentration,
  SectorSeverity,
} from "@/lib/queries";

/**
 * Sector concentration strip — the "am I over-concentrated?" glance
 * that sits near the top of the Portfolio page.
 *
 * Renders as a horizontal strip of the top-3 sectors with severity-
 * coded pills. Severity thresholds baked in per HANDOVER §15.2:
 *
 *   safe    (< 20%)  → muted, no icon        (silent)
 *   info    (20–25%) → blue, Info icon        (informational)
 *   warning (25–30%) → amber, AlertTriangle   (⚠️ pay attention)
 *   alert   (> 30%)  → red, AlertCircle       (🔴 reconsider)
 *
 * Users can click a sector to jump to the full SectorExposure card
 * below (anchor scroll). Companies count in tooltip provides drill-down
 * without leaving the page.
 *
 * The FULL sector breakdown (SectorExposure tiles) lives further down
 * the page. This strip is warning-first; that card is comprehensive.
 * The intentional redundancy is defensible: a user scanning the page
 * quickly should hit the warning strip before wading into tiles.
 */
export function SectorConcentrationStrip({
  sectors,
}: {
  sectors: SectorConcentration[];
}) {
  if (!sectors.length) return null;
  const hasWarning = sectors.some(
    (s) => s.severity === "warning" || s.severity === "alert"
  );

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Sector concentration
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Top 3 sectors weighted by look-through position ·{" "}
            {hasWarning
              ? "one or more above the comfort threshold"
              : "all within a healthy range"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {sectors.map((s) => (
          <SectorPill key={s.name} sector={s} />
        ))}
      </div>
    </Card>
  );
}

function SectorPill({ sector }: { sector: SectorConcentration }) {
  const style = SEVERITY_STYLES[sector.severity];
  const Icon = style.icon;

  return (
    <Tooltip
      content={
        <div className="min-w-[220px] space-y-1">
          <div className="font-medium">{sector.name}</div>
          <div className="opacity-80">
            Held via {sector.companies}{" "}
            {sector.companies === 1 ? "stock" : "stocks"} across your funds
          </div>
          <div className="opacity-60">{style.description}</div>
        </div>
      }
      side="bottom"
    >
      <button
        type="button"
        onClick={() => {
          // Anchor-scroll to the full sector exposure card below
          document
            .getElementById("sector-exposure")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        className={cn(
          "group flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors",
          style.container
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            size={14}
            className={cn("shrink-0", style.icon_color)}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {sector.name}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {sector.companies}{" "}
              {sector.companies === 1 ? "stock" : "stocks"}
            </div>
          </div>
        </div>
        <div className={cn("text-lg font-semibold tabular-nums", style.text)}>
          {sector.pct.toFixed(1)}%
        </div>
      </button>
    </Tooltip>
  );
}

/**
 * Severity style table — keeps color choice + icon + description in one
 * place so the visual language stays consistent even if thresholds get
 * tuned later.
 *
 * All colors use existing theme tokens (--success/--warning/--danger/
 * --primary) so they auto-swap between light/dark themes without extra
 * CSS.
 */
const SEVERITY_STYLES: Record<
  SectorSeverity,
  {
    icon: typeof Shield;
    icon_color: string;
    container: string;
    text: string;
    description: string;
  }
> = {
  safe: {
    icon: Shield,
    icon_color: "text-[hsl(var(--success))]",
    container:
      "border-border bg-muted/20 hover:bg-muted/30",
    text: "text-foreground",
    description: "< 20% — healthy diversification",
  },
  info: {
    icon: Info,
    icon_color: "text-[hsl(var(--primary))]",
    container:
      "border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.06)] hover:bg-[hsl(var(--primary)/0.10)]",
    text: "text-[hsl(var(--primary))]",
    description: "20–25% — informational, worth watching",
  },
  warning: {
    icon: AlertTriangle,
    icon_color: "text-[hsl(var(--warning))]",
    container:
      "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] hover:bg-[hsl(var(--warning)/0.12)]",
    text: "text-[hsl(var(--warning))]",
    description: "25–30% — above comfort threshold, review",
  },
  alert: {
    icon: AlertCircle,
    icon_color: "text-[hsl(var(--danger))]",
    container:
      "border-[hsl(var(--danger)/0.4)] bg-[hsl(var(--danger)/0.08)] hover:bg-[hsl(var(--danger)/0.12)]",
    text: "text-[hsl(var(--danger))]",
    description: "> 30% — concentrated exposure, reconsider",
  },
};
