"use client";

import { useState } from "react";
import { ChevronDown, Globe } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn, fmtL } from "@/lib/utils";
import type { ForeignLookthrough } from "@/lib/queries";
import { ForeignHoldingsTable } from "@/components/portfolio/ForeignHoldingsTable";

const COLLAPSED = 10;

/**
 * Cross-fund foreign look-through — your real exposure to each foreign
 * company, summed across every fund that holds it (ICICI Nasdaq, HDFC DM,
 * and domestic funds' US slices like PPFAS). Top 10 by default; expand to a
 * scrollable list of every company. Its own lens, separate from the
 * Indian-MF Top Stocks so US names don't muddy that view.
 */
export function ForeignLookthroughCard({ data }: { data: ForeignLookthrough }) {
  const [expanded, setExpanded] = useState(false);

  if (data.stocks.length === 0) return null;
  const shown = expanded ? data.stocks : data.stocks.slice(0, COLLAPSED);

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border p-5">
        <div className="flex items-center gap-1.5">
          <Globe size={13} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Foreign look-through
          </h2>
        </div>
        <p className="mt-0.5 kicker">
          Your foreign stocks across every fund · {fmtL(data.total_inr)} ·{" "}
          {data.total_companies} companies
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.by_fund.map((f) => (
            <span
              key={f.fund_code}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 text-[11px]"
            >
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                {f.fund_code}
              </span>
              <span className="font-medium text-foreground tabular-nums">
                {fmtL(f.inr)}
              </span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Includes domestic funds&apos; foreign slices (e.g. PPFAS&apos;s US
          names), so this exceeds your International asset class.
        </p>
      </div>

      <div
        className={cn(
          "overflow-x-auto",
          expanded && "max-h-[28rem] overflow-y-auto"
        )}
      >
        <ForeignHoldingsTable
          stocks={shown}
          pctLabel="% of foreign"
          pctFor={(s) => s.pct_of_foreign}
        />
      </div>

      {data.stocks.length > COLLAPSED && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          {expanded ? "Show top 10" : `Show top ${data.stocks.length}`}
          <ChevronDown
            size={13}
            className={cn("transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
    </Card>
  );
}
