"use client";

import { useEffect, useState } from "react";
import { Globe, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { fmtINR, fmtL } from "@/lib/utils";
import type { ForeignCountry } from "@/lib/queries";
import { ForeignHoldingsTable } from "@/components/portfolio/ForeignHoldingsTable";

/**
 * Country composition of your foreign book — where your overseas money
 * sits, by weight. Each row's bar is scaled to the biggest country so the
 * small ones stay visible; click any country to drill into its holdings
 * (top 100 by weight) in a modal.
 */
export function CountryCompositionCard({
  countries,
}: {
  countries: ForeignCountry[];
}) {
  const [selected, setSelected] = useState<ForeignCountry | null>(null);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (countries.length === 0) return null;
  const maxPct = countries[0]?.pct_of_foreign || 100;

  return (
    <>
      <Card className="overflow-hidden">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-1.5">
            <Globe size={13} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              Country composition
            </h2>
          </div>
          <p className="mt-0.5 kicker">
            Where your foreign money sits · {countries.length} countries · click
            to drill in
          </p>
        </div>
        <div className="divide-y divide-border">
          {countries.map((c) => (
            <button
              key={c.country}
              onClick={() => setSelected(c)}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted/30"
            >
              <span className="w-32 shrink-0 truncate text-sm font-medium text-foreground sm:w-40">
                {c.country}
              </span>
              <span className="relative hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted/40 sm:block">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-[hsl(280_65%_70%)]"
                  style={{
                    width: `${Math.max(2, (c.pct_of_foreign / maxPct) * 100)}%`,
                  }}
                />
              </span>
              <span className="w-14 shrink-0 text-right text-sm font-medium tabular-nums text-foreground">
                {c.pct_of_foreign.toFixed(1)}%
              </span>
              <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {fmtINR(c.effective_inr)}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {selected && (
        <CountryModal country={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function CountryModal({
  country,
  onClose,
}: {
  country: ForeignCountry;
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
              {country.country}
            </h3>
            <p className="mt-0.5 kicker">
              {country.pct_of_foreign.toFixed(1)}% of foreign ·{" "}
              {fmtL(country.effective_inr)} · {country.n_companies}{" "}
              {country.n_companies === 1 ? "holding" : "holdings"}
              {country.n_companies > country.stocks.length &&
                ` · top ${country.stocks.length}`}
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
            stocks={country.stocks}
            pctLabel="% of country"
            pctFor={(s) =>
              country.effective_inr > 0
                ? (s.effective_inr / country.effective_inr) * 100
                : 0
            }
          />
        </div>
      </div>
    </div>
  );
}
