"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  Repeat,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { CapType, Fund } from "@/lib/queries";
import { cn, fmtDateIST, fmtDateShort, fmtINR, fmtL, fmtPct } from "@/lib/utils";

type Holding = {
  isin: string;
  company_name: string;
  weighting_pct: number;
  portfolio_date: string | null;
  extracted_at: string | null;
};

type NonSecurity = {
  category: string;
  weighting_pct: number;
  portfolio_date: string | null;
};

type Sector = {
  name: string;
  weighting_pct: number;
  count: number;
};

/**
 * Per-fund cap breakdown returned by /api/fund-details. Mirrors the
 * portfolio-wide donut rules (NN50 counts 100% Large as of 2026-07-27;
 * US region counts as International regardless of mcap) so numbers
 * reconcile across screens. Debt combines Bonds + Cash & Equivalents
 * into one "fixed-income-ish" bucket per user convention; bondsPct /
 * cashPct expose the sub-split for the tooltip.
 */
type CapBreakdown = {
  large: number;
  mid: number;
  small: number;
  intl: number;
  debt: number;
  reit: number;
  other: number;
  totalCoverage: number;
  bondsPct: number;
  cashPct: number;
};

type Diagnostics = {
  synced_at: string;
  unresolved: {
    company_name: string;
    dhan_isin: string | null;
    weighting_pct: number;
    note: string;
  }[];
  unknown_holding_types: {
    company_name: string;
    holding_type: string;
    weighting_pct: number;
  }[];
  data_warnings: string[];
};

/**
 * One row of the lot-level ledger returned to the modal — union of
 * Groww orders + CAS transactions for this fund_code. See
 * `app/api/fund-details/[code]/route.ts` for the union logic.
 */
type FundTransaction = {
  id: string;
  source: "groww" | "cas";
  date: string;
  type: string | null;
  amount_inr: number | null;
  units: number | null;
  nav: number | null;
  folio_number: string | null;
  status: string | null;
  description: string | null;
};

type TxStats = {
  purchases: number;
  redemptions: number;
  purchaseCount: number;
  redemptionCount: number;
};

type FundDetailsResponse = {
  fund: Fund;
  holdings: Holding[];
  nonSecurities: NonSecurity[];
  sectors: Sector[];
  classifiedWeight: number;
  unclassifiedWeight: number;
  capBreakdown: CapBreakdown | null;
  diagnostics: Diagnostics | null;
  transactions: FundTransaction[];
  txStats: TxStats;
};

export function FundDetailsModal({
  fundCode,
  onClose,
}: {
  fundCode: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<FundDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllHoldings, setShowAllHoldings] = useState(false);
  const [showAllTx, setShowAllTx] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fetch fund data whenever a new fund is selected. Aborts an in-flight
  // request if the user rapidly clicks between cards.
  useEffect(() => {
    if (!fundCode) {
      setData(null);
      setError(null);
      setShowAllHoldings(false);
      setShowAllTx(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    setShowAllHoldings(false);
    setShowAllTx(false);
    fetch(`/api/fund-details/${fundCode}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: FundDetailsResponse) => setData(d))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [fundCode]);

  // ESC key + body scroll lock. Runs only when modal is actually open.
  useEffect(() => {
    if (!fundCode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fundCode, onClose]);

  if (!fundCode) return null;

  const fund = data?.fund;
  const gain = fund ? fund.current_value_inr - fund.invested_inr : 0;
  const gainPct = fund && fund.invested_inr ? (gain / fund.invested_inr) * 100 : 0;
  const holdings = data?.holdings ?? [];
  const nonSec = data?.nonSecurities ?? [];
  const sectors = data?.sectors ?? [];
  const HOLDINGS_PREVIEW = 20;
  const shownHoldings = showAllHoldings ? holdings : holdings.slice(0, HOLDINGS_PREVIEW);
  const maxWeight = holdings[0]?.weighting_pct ?? 1;

  // Dhan returns each hedge/cash/FoF position as a separate row, which makes
  // the section 20+ rows of duplicate category labels. Aggregating by category
  // preserves the total weight (already validated: sum before === sum after)
  // and makes the section actually scannable. Purely a display transform —
  // the underlying rows in fund_non_security_holdings are untouched.
  const nonSecByCategory = (() => {
    const map = new Map<string, { weighting_pct: number; count: number }>();
    for (const n of nonSec) {
      const key = n.category || "Uncategorized";
      const cur = map.get(key) ?? { weighting_pct: 0, count: 0 };
      cur.weighting_pct += n.weighting_pct;
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([category, s]) => ({ category, ...s }))
      .sort((a, b) => b.weighting_pct - a.weighting_pct);
  })();
  const nonSecTotalWeight = nonSec.reduce((s, n) => s + n.weighting_pct, 0);
  const nonSecMaxWeight = Math.max(...nonSecByCategory.map((c) => c.weighting_pct), 0);
  const securityTotalWeight = holdings.reduce((s, h) => s + h.weighting_pct, 0);
  const totalCoverage = securityTotalWeight + nonSecTotalWeight;
  // Same portfolio_date on every row in a given sync (Dhan reports one per
  // fund per disclosure). Grab the first non-null from either table.
  const portfolioDate =
    holdings.find((h) => h.portfolio_date)?.portfolio_date ??
    nonSec.find((n) => n.portfolio_date)?.portfolio_date ??
    null;
  const lastResync =
    holdings.find((h) => h.extracted_at)?.extracted_at ??
    fund?.updated_at ??
    null;

  // Transactions view state — collapsed by default at 8 rows so the
  // modal doesn't grow unbounded for funds with heavy purchase
  // history. Same "show all" affordance pattern as Holdings.
  const transactions = data?.transactions ?? [];
  const txStats = data?.txStats ?? {
    purchases: 0,
    redemptions: 0,
    purchaseCount: 0,
    redemptionCount: 0,
  };
  const TX_PREVIEW = 8;
  const shownTx = showAllTx ? transactions : transactions.slice(0, TX_PREVIEW);
  // Compact date range subtitle helper — first / last dates from the
  // (already-sorted-DESC) transactions array. Plain const (not useMemo)
  // because it sits AFTER the `if (!fundCode) return null;` early
  // return above — introducing a hook here would violate rules-of-hooks
  // (hook count varies between renders). The computation is O(1) anyway,
  // so memoisation buys nothing.
  const txDateRange =
    transactions.length === 0
      ? null
      : {
          oldest: transactions[transactions.length - 1].date,
          newest: transactions[0].date,
        };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        // Only close when the click target is the backdrop itself, not any
        // element inside the dialog. Prevents a drag-select ending outside
        // the dialog from accidentally closing it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fund-modal-title"
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close fund details"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        {loading && !data && (
          <div className="flex flex-1 items-center justify-center p-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
            <div className="text-sm font-medium text-[hsl(var(--danger))]">
              Could not load fund details
            </div>
            <div className="text-xs text-muted-foreground">{error}</div>
          </div>
        )}

        {fund && !error && (
          <>
            {/* Header */}
            <div className="border-b border-border p-6 pr-14">
              <h2
                id="fund-modal-title"
                className="text-base font-semibold text-foreground"
              >
                {fund.fund_name}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-mono uppercase text-muted-foreground">
                  {fund.fund_code}
                </span>
                <Badge variant={fund.cap_type as CapType}>{fund.cap_type}</Badge>
                {fund.nav != null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      NAV {fmtDateShort(fund.nav_date)} · ₹{fund.nav.toFixed(4)}
                    </span>
                  </>
                )}
                {portfolioDate && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">
                      Data as of{" "}
                      <span className="font-medium text-foreground">
                        {fmtDateShort(portfolioDate)}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* Stat grid */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Current" value={fmtL(fund.current_value_inr)} />
                <Stat label="Invested" value={fmtL(fund.invested_inr)} />
                <Stat
                  label="Gain"
                  value={fmtINR(gain)}
                  tone={gain >= 0 ? "success" : "danger"}
                  prefix={gain >= 0 ? "+" : ""}
                />
                <Stat
                  label="Return"
                  value={fmtPct(gainPct, { sign: true })}
                  tone={gainPct >= 0 ? "success" : "danger"}
                />
              </div>

              {/* Cap breakdown — the "what is this fund actually made of?"
                  view. Same look-through logic as the portfolio-wide donut
                  (NN50 stocks count 100% Large as of 2026-07-27) but scoped
                  to just this fund. Debt combines Bonds + Cash & Equivalents into
                  one bucket per user convention. Only rendered when the
                  API returned a computed breakdown AND at least one bucket
                  is non-zero (freshly-synced funds with no detail rows
                  yet would otherwise show an empty bar). */}
              {data?.capBreakdown &&
                data.capBreakdown.totalCoverage > 0 && (
                  <CapBreakdownSection breakdown={data.capBreakdown} />
                )}

              {/* Holdings — stocks/bonds first since these are what the fund
                  actually invests in. Non-security allocation (cash, hedges,
                  FoF) is de-prioritized below. */}
              {holdings.length > 0 && (
                <Section
                  title={`Holdings (${holdings.length})`}
                  subtitle={`${holdings
                    .reduce((s, h) => s + h.weighting_pct, 0)
                    .toFixed(1)}% of fund`}
                >
                  <div className="space-y-1.5">
                    {shownHoldings.map((h) => (
                      <WeightRow
                        key={h.isin}
                        label={h.company_name}
                        subLabel={h.isin}
                        weight={h.weighting_pct}
                        maxWeight={maxWeight}
                      />
                    ))}
                  </div>
                  {holdings.length > HOLDINGS_PREVIEW && (
                    <button
                      onClick={() => setShowAllHoldings((v) => !v)}
                      className="mt-3 text-xs font-medium text-[hsl(var(--primary))] hover:underline"
                    >
                      {showAllHoldings
                        ? `Show top ${HOLDINGS_PREVIEW}`
                        : `Show all ${holdings.length} holdings`}
                    </button>
                  )}
                </Section>
              )}

              {/* Non-security allocation — aggregated by category (Dhan returns
                  one row per hedge position). Raw row count kept in the
                  subtitle for transparency. */}
              {nonSecByCategory.length > 0 && (
                <Section
                  title="Non-security allocation"
                  subtitle={
                    nonSec.length > nonSecByCategory.length
                      ? `${nonSecTotalWeight.toFixed(1)}% of fund · ${nonSecByCategory.length} categories · ${nonSec.length} positions`
                      : `${nonSecTotalWeight.toFixed(1)}% of fund · ${nonSecByCategory.length} categories`
                  }
                >
                  <div className="space-y-1.5">
                    {nonSecByCategory.map((c) => (
                      <WeightRow
                        key={c.category}
                        label={c.category}
                        subLabel={
                          c.count > 1
                            ? `${c.count} positions`
                            : undefined
                        }
                        weight={c.weighting_pct}
                        maxWeight={nonSecMaxWeight}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {/* Sectors */}
              {sectors.length > 0 && (
                <Section
                  title="Sector exposure"
                  subtitle={
                    data && data.unclassifiedWeight > 0.5
                      ? `${data.classifiedWeight.toFixed(1)}% classified · ${data.unclassifiedWeight.toFixed(1)}% unclassified`
                      : `${sectors.length} sectors`
                  }
                >
                  <div className="space-y-1.5">
                    {sectors.map((s) => (
                      <WeightRow
                        key={s.name}
                        label={s.name}
                        subLabel={`${s.count} ${s.count === 1 ? "company" : "companies"}`}
                        weight={s.weighting_pct}
                        maxWeight={sectors[0].weighting_pct}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {/* Lot-level transactions — every purchase / redemption /
                  switch we know about for this fund_code, unioned across
                  Groww orders and MFCentral CAS. Placed here (after the
                  composition sections) because it answers "when did I
                  actually buy this?" — a follow-up question once the
                  user's absorbed what the fund IS. Collapsed to top 8
                  rows by default so the modal stays scannable. */}
              {transactions.length > 0 && txDateRange && (
                <Section
                  title={`Transactions (${transactions.length})`}
                  subtitle={
                    txStats.purchaseCount > 0 || txStats.redemptionCount > 0
                      ? [
                          txStats.purchaseCount > 0
                            ? `${txStats.purchaseCount} buy · +${fmtINR(txStats.purchases)}`
                            : null,
                          txStats.redemptionCount > 0
                            ? `${txStats.redemptionCount} sell · −${fmtINR(txStats.redemptions)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : `${fmtDateShort(txDateRange.oldest)} → ${fmtDateShort(txDateRange.newest)}`
                  }
                >
                  <TransactionList transactions={shownTx} />
                  {transactions.length > TX_PREVIEW && (
                    <button
                      onClick={() => setShowAllTx((v) => !v)}
                      className="mt-3 text-xs font-medium text-[hsl(var(--primary))] hover:underline"
                    >
                      {showAllTx
                        ? `Show recent ${TX_PREVIEW}`
                        : `Show all ${transactions.length} transactions`}
                    </button>
                  )}
                </Section>
              )}

              {holdings.length === 0 && nonSec.length === 0 && (
                <div className="mt-8 rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                  No look-through holdings recorded yet. Try clicking{" "}
                  <span className="font-medium text-foreground">Resync now</span>{" "}
                  to pull the latest from Dhan.
                </div>
              )}

              {/* Unresolved holdings — surfaced only when Dhan returned
                  something we couldn't classify. Placed just above Sync
                  diagnostics because it's actionable (needs seeding in
                  master_security_classification), while diagnostics are
                  passive info. */}
              {data?.diagnostics &&
                data.diagnostics.unresolved.length > 0 && (
                  <section className="mt-8 rounded-lg border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-4">
                    <div className="mb-3 flex items-start gap-2">
                      <AlertTriangle
                        size={14}
                        className="mt-0.5 shrink-0 text-[hsl(var(--warning))]"
                      />
                      <div>
                        <h3 className="text-sm font-semibold text-[hsl(var(--warning))]">
                          Unresolved holdings ({data.diagnostics.unresolved.length})
                        </h3>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Dhan reported these but we couldn&apos;t match them
                          against{" "}
                          <span className="font-mono">
                            master_security_classification
                          </span>
                          . They&apos;re excluded from coverage, allocation, and
                          sector breakdowns until seeded.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {data.diagnostics.unresolved.map((u, i) => (
                        <div
                          key={`${u.company_name}-${i}`}
                          className="rounded border border-border bg-card px-3 py-2 text-[11px]"
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <div className="truncate font-medium text-foreground">
                              {u.company_name}
                            </div>
                            <div className="shrink-0 font-mono font-medium text-foreground">
                              {u.weighting_pct.toFixed(2)}%
                            </div>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
                            {u.dhan_isin && (
                              <span>
                                Dhan ISIN:{" "}
                                <span className="font-mono text-foreground">
                                  {u.dhan_isin}
                                </span>
                              </span>
                            )}
                            <span className="text-[10px] italic">{u.note}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[10px] text-muted-foreground">
                      To resolve: add these ISINs to{" "}
                      <span className="font-mono">
                        master_security_classification
                      </span>{" "}
                      with correct mcap_classification, then hit Resync.
                    </p>
                  </section>
                )}

              {data?.diagnostics &&
                data.diagnostics.unknown_holding_types.length > 0 && (
                  <section className="mt-4 rounded-lg border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-4">
                    <div className="mb-2 flex items-start gap-2">
                      <AlertTriangle
                        size={14}
                        className="mt-0.5 shrink-0 text-[hsl(var(--warning))]"
                      />
                      <div>
                        <h3 className="text-sm font-semibold text-[hsl(var(--warning))]">
                          Unknown holding types (
                          {data.diagnostics.unknown_holding_types.length})
                        </h3>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Dhan returned holdings with{" "}
                          <span className="font-mono">pmd_holdingtype</span>{" "}
                          codes we haven&apos;t classified. Add these to{" "}
                          <span className="font-mono">HOLDING_TYPES_IN_SCOPE</span>{" "}
                          or{" "}
                          <span className="font-mono">NON_SECURITY_CATEGORY</span>{" "}
                          in the sync route.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      {data.diagnostics.unknown_holding_types.map((u, i) => (
                        <div
                          key={`${u.company_name}-${u.holding_type}-${i}`}
                          className="flex items-baseline justify-between gap-3 rounded border border-border bg-card px-3 py-1.5 text-[11px]"
                        >
                          <span className="truncate text-foreground">
                            {u.company_name}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            type{" "}
                            <span className="font-mono text-foreground">
                              {u.holding_type}
                            </span>{" "}
                            · {u.weighting_pct.toFixed(2)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

              {/* Sync diagnostics — deliberately at the bottom, small and
                  muted. Only interesting when the user is debugging why a
                  card shows Low coverage or wants to verify a >100% figure. */}
              {(holdings.length > 0 || nonSec.length > 0) && (
                <section className="mt-8 rounded-lg border border-border bg-muted/10 p-4">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sync diagnostics
                  </h3>
                  <dl className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
                    <DiagRow
                      label="Total weight coverage"
                      value={`${totalCoverage.toFixed(2)}%`}
                      hint={
                        totalCoverage > 100.5
                          ? "Above 100% is expected when a fund uses derivatives or hedges alongside its underlying holdings."
                          : totalCoverage < 95
                          ? "Below 95% typically means some ISINs aren't in master_security_classification yet."
                          : undefined
                      }
                    />
                    <DiagRow
                      label="Position breakdown"
                      value={`${holdings.length} securities + ${nonSec.length} non-security`}
                    />
                    <DiagRow
                      label="Securities weight"
                      value={`${securityTotalWeight.toFixed(2)}%`}
                    />
                    <DiagRow
                      label="Non-security weight"
                      value={`${nonSecTotalWeight.toFixed(2)}%`}
                    />
                    <DiagRow
                      label="Fund disclosure date"
                      value={portfolioDate ? fmtDateShort(portfolioDate) : "—"}
                    />
                    <DiagRow
                      label="Last resync from Dhan"
                      value={lastResync ? fmtDateShort(lastResync) : "—"}
                    />
                  </dl>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DiagRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 last:border-b-0 sm:border-b-0 sm:py-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className="text-right font-mono font-medium text-foreground"
        title={hint}
      >
        {value}
        {hint && (
          <span className="ml-1 text-muted-foreground">·</span>
        )}
      </dd>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  prefix,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger";
  prefix?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="kicker">{label}</div>
      <div
        className={cn(
          "mt-1 font-semibold text-foreground",
          tone === "success" && "text-[hsl(var(--success))]",
          tone === "danger" && "text-[hsl(var(--danger))]"
        )}
      >
        {prefix}
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Compact transaction row list for the fund modal.
 *
 * Visual language mirrors the Credits page `MfContributionsLog` so the
 * user has one consistent way to read MF ledger rows across the app,
 * but simplified for the constrained modal width:
 *   • Date column left-aligned (fmtDateIST — IST-anchored).
 *   • Type + source badges (Purchase/Redemption/Switch + Groww/CAS).
 *   • Amount right-aligned, signed by kind.
 *   • Units + NAV suppressed on narrow rows (available in the tooltip).
 *
 * Kind classification kept trivial (case-insensitive on `type`); order
 * types outside PURCHASE / REDEMPTION / SWITCH_* render as neutral
 * "Order" — this covers SIP registration rows and any future types we
 * haven't classified.
 */
function TransactionList({ transactions }: { transactions: FundTransaction[] }) {
  return (
    <ul className="space-y-1.5">
      {transactions.map((t) => {
        const kind = classifyKind(t.type);
        const isCas = t.source === "cas";
        const isRedemption = kind === "redemption";
        const isSwitch = kind === "switch";
        return (
          <li
            key={t.id}
            className="grid grid-cols-[80px_1fr_auto] items-center gap-2 rounded-md border border-border bg-muted/10 px-2.5 py-2 text-xs"
            title={
              t.description ??
              (t.units != null && t.nav != null
                ? `${Math.abs(t.units).toFixed(3)} units @ ₹${t.nav.toFixed(4)}`
                : undefined)
            }
          >
            <div className="whitespace-nowrap tabular-nums text-muted-foreground">
              {fmtDateIST(t.date)}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  kind === "purchase" &&
                    "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]",
                  isRedemption &&
                    "bg-[hsl(var(--danger)/0.12)] text-[hsl(var(--danger))]",
                  isSwitch &&
                    "bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]",
                  kind === "other" && "bg-muted/40 text-muted-foreground"
                )}
              >
                {kind === "purchase" && <ArrowUpRight size={10} />}
                {isRedemption && <ArrowDownRight size={10} />}
                {isSwitch && <Repeat size={10} />}
                {kindLabel(kind, t.type)}
              </span>
              <span
                className={cn(
                  "rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                  isCas
                    ? "bg-muted/40 text-muted-foreground"
                    : "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]"
                )}
                title={
                  isCas
                    ? "From MFCentral eCAS — RTA-authoritative"
                    : "From Groww order history"
                }
              >
                {isCas ? "CAS" : "Groww"}
              </span>
              {/* Groww-only pending indicator; CAS rows are always settled. */}
              {!isCas && t.status && t.status !== "COMPLETED" && (
                <span className="rounded bg-[hsl(var(--warning)/0.12)] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-[hsl(var(--warning))]">
                  {t.status.toLowerCase()}
                </span>
              )}
              {/* Folio — muted, useful when comparing rows across
                  multiple folios for the same fund. */}
              {t.folio_number && (
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  #{t.folio_number}
                </span>
              )}
            </div>
            <div
              className={cn(
                "whitespace-nowrap text-right font-semibold tabular-nums",
                isRedemption
                  ? "text-[hsl(var(--danger))]"
                  : isSwitch
                  ? "text-muted-foreground"
                  : "text-[hsl(var(--success))]"
              )}
            >
              {t.amount_inr != null
                ? `${isRedemption ? "−" : isSwitch ? "" : "+"}${fmtINR(
                    Math.abs(Number(t.amount_inr))
                  )}`
                : "—"}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type TxKind = "purchase" | "redemption" | "switch" | "other";
function classifyKind(orderType: string | null): TxKind {
  if (!orderType) return "other";
  const t = orderType.toUpperCase();
  if (t === "PURCHASE") return "purchase";
  if (t === "REDEMPTION" || t === "REDEEM") return "redemption";
  if (t.startsWith("SWITCH")) return "switch";
  return "other";
}
function kindLabel(kind: TxKind, rawType: string | null): string {
  if (kind === "purchase") return "Purchase";
  if (kind === "redemption") return "Redemption";
  if (kind === "switch") {
    // Preserve SWITCH_IN vs SWITCH_OUT distinction — they're
    // materially different from a lot-tracking POV.
    const t = (rawType ?? "").toUpperCase();
    if (t === "SWITCH_IN") return "Switch in";
    if (t === "SWITCH_OUT") return "Switch out";
    return "Switch";
  }
  return "Order";
}

function WeightRow({
  label,
  subLabel,
  weight,
  maxWeight,
}: {
  label: string;
  subLabel?: string;
  weight: number;
  maxWeight: number;
}) {
  const barPct = maxWeight > 0 ? (weight / maxWeight) * 100 : 0;
  return (
    <div className="grid grid-cols-[1fr_140px_56px] items-center gap-3 text-xs">
      <div className="min-w-0">
        <div className="truncate text-foreground">{label}</div>
        {subLabel && (
          <div className="truncate font-mono text-[10px] uppercase text-muted-foreground">
            {subLabel}
          </div>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[hsl(var(--primary))]"
          style={{ width: `${barPct}%` }}
        />
      </div>
      <div className="text-right font-medium text-muted-foreground">
        {weight.toFixed(2)}%
      </div>
    </div>
  );
}

/**
 * Cap breakdown chip grid with a stacked bar on top.
 *
 * Visualisation choice: a single horizontal stacked bar (compact,
 * scannable, works for funds where one bucket dominates like a pure
 * large-cap index) + a chip grid below with per-bucket ₹/%/label.
 *
 * Colour palette matches the portfolio-page donuts so users can
 * mentally connect "this fund is contributing X% Large" to the
 * portfolio-total Large slice. `debt` deliberately uses a warm grey
 * (fixed-income convention) even though the bar sits next to purple
 * (Large) — the visual distinction reads correctly on both light
 * and dark themes.
 *
 * Buckets with 0% (or < 0.05% which rounds to 0.0) are hidden from
 * the chip grid, otherwise pure equity funds show 4 empty rows.
 */
function CapBreakdownSection({ breakdown }: { breakdown: CapBreakdown }) {
  const total = breakdown.totalCoverage;
  const BUCKETS: {
    key: keyof CapBreakdown;
    label: string;
    color: string;
    dotColor: string;
    hint?: string;
  }[] = [
    {
      key: "large",
      label: "Large cap",
      color: "hsl(248 85% 72%)",
      dotColor: "hsl(248 85% 72%)",
      hint: "Nifty 50 stocks at 100%, Nifty Next 50 at 75%",
    },
    {
      key: "mid",
      label: "Mid cap",
      color: "hsl(150 60% 55%)",
      dotColor: "hsl(150 60% 55%)",
      hint: "Nifty Midcap 150 stocks + 25% of NN50 positions",
    },
    {
      key: "small",
      label: "Small cap",
      color: "hsl(350 75% 65%)",
      dotColor: "hsl(350 75% 65%)",
      hint: "Small + Micro + Nano cap stocks",
    },
    {
      key: "intl",
      label: "International",
      color: "hsl(280 65% 70%)",
      dotColor: "hsl(280 65% 70%)",
      hint: "US-region stocks (S&P 500 / Nasdaq 100 / other)",
    },
    {
      key: "debt",
      label: "Debt",
      color: "hsl(220 15% 55%)",
      dotColor: "hsl(220 15% 55%)",
      hint: `Bonds + Cash & Equivalents (${breakdown.bondsPct.toFixed(2)}% + ${breakdown.cashPct.toFixed(2)}%)`,
    },
    {
      key: "reit",
      label: "REIT",
      color: "hsl(35 80% 60%)",
      dotColor: "hsl(35 80% 60%)",
      hint: "Real-estate investment trusts",
    },
    {
      key: "other",
      label: "Other",
      color: "hsl(220 8% 40%)",
      dotColor: "hsl(220 8% 40%)",
      hint: "Derivative/hedge, fund-of-funds, regulatory reserve, unclassified equity",
    },
  ];

  // Filter to buckets with material weight. Keeping 0.05% cutoff so
  // a rounding-error residual doesn't show a "0.0%" row.
  const shown = BUCKETS.filter(
    (b) => (breakdown[b.key] as number) >= 0.05
  );

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          Cap breakdown
        </h3>
        <span className="text-[11px] text-muted-foreground">
          Look-through · {total.toFixed(1)}% of fund
        </span>
      </div>

      {/* Stacked horizontal bar. flex + widths as % of totalCoverage
          (not 100) so an under-covered fund reads correctly — the
          bar visually reflects "some fund weight is unclassified"
          rather than pretending everything sums to 100. */}
      <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {shown.map((b) => {
          const val = breakdown[b.key] as number;
          const pct = total > 0 ? (val / total) * 100 : 0;
          return (
            <div
              key={b.key}
              className="h-full"
              style={{ width: `${pct}%`, background: b.color }}
              title={`${b.label}: ${val.toFixed(2)}%`}
            />
          );
        })}
      </div>

      {/* Chip grid: 2 cols on narrow, 3 cols on sm+, up to 4 on md+.
          Each chip shows dot + label + numeric weight. Hint is
          surfaced via the native `title` attribute — no popover to
          avoid modal-in-modal complexity. */}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {shown.map((b) => {
          const val = breakdown[b.key] as number;
          return (
            <li
              key={b.key}
              className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-2 text-xs"
              title={b.hint}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: b.dotColor }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-muted-foreground">
                  {b.label}
                </div>
                <div className="font-semibold tabular-nums text-foreground">
                  {val.toFixed(2)}%
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
