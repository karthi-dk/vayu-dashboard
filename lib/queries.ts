import type { PostgrestError } from "@supabase/supabase-js";
// Alias sbServer → sb to keep the 25 in-file call sites (sb.from(...))
// unchanged. The underlying client is the server-only, service_role-
// scoped one — see lib/supabase.ts. If you're reading this in a
// client component, you shouldn't be: this file is server-only.
import { sbServer as sb } from "./supabase";
import { computeXirr, type CashFlow } from "./xirr";
// Constant-only import (staleness threshold) — the refreshIndexLevels()
// function itself is imported lazily inside fetchIndexLevels() so the
// Yahoo client isn't pulled into the cold-start bundle for pages that
// never trigger a refresh.
import { INDEX_LEVELS_STALE_MS } from "./indexLevels/refresh";

// ─── PostgREST pagination helpers ──────────────────────────────────────────
//
// This project's Supabase instance is configured with `db-max-rows = 1000`,
// which caps EVERY response at 1000 rows regardless of the Range header
// the client sends. That means `.range(0, 9999)` looks like it should
// return up to 10k rows but silently truncates at 1000.
//
// Any query against a table that can exceed 1000 rows MUST use one of
// these helpers. Currently that includes:
//   • master_security_classification (~3,200 rows after EQUITY_L backfill)
//   • nps_nav_history                (~8,700 rows, ~2,900 per scheme)
//   • fund_holdings_detail           (~930 rows, on the edge)
// …and — after the 2026-07-28 audit — these growing tables that are
// still under the cap today but will trip it in 2-4 years at current
// growth rates:
//   • nw_daily                        (~1 row/day, drives every trend chart)
//   • mf_daily_reconstructed          (~1 row/day, pre-tracking MF curve)
//   • mf_transactions                 (~200-500 rows/yr, the MF ledger)
//   • mf_contributions                (deprecated Groww ledger)
// Paginating them proactively costs nothing today (each call still
// completes in one round-trip while <1000) and buys unlimited runway.
//
// The caller passes a factory returning a fresh query builder with
// .range(from, to) applied — the helper drives the pagination loop
// and returns either a flat array (fetchAllPages) or a { data, error }
// tuple that mirrors a single PostgREST response (fetchAllPagesResult).
// The latter is preferred inside Promise.all() blocks that already
// destructure `xRes.data` / `xRes.error` — you get pagination for
// free without touching downstream error-handling code.
//
// Behaviour matches the existing pattern in
// app/api/sync-fund-holdings/[isin]/route.ts:loadMaster() which
// discovered this cap the hard way on 2026-07-14 when bond ISINs
// silently vanished from the classification map.
export async function fetchAllPages<T>(
  buildQuery: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * `fetchAllPages` variant that returns a { data, error } tuple mirroring
 * a single PostgREST response. Use this at Promise.all() call sites
 * that already destructure into `xRes.data` / `xRes.error` — the
 * downstream error-handling code (including `if (code === "42P01")`
 * missing-migration branches) works untouched.
 *
 * On the FIRST page failure it short-circuits and returns
 * { data: [], error }, matching what a plain .select() would surface.
 * On success `.data` is the full concatenated result across all pages.
 * Never throws — the caller decides whether to throw or degrade.
 */
export async function fetchAllPagesResult<T>(
  buildQuery: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) return { data: [], error };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { data: all, error: null };
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type NwRow = {
  date: string;
  mf_value: number;
  mf_invested: number;
  // Equity/Debt breakdown of the MF slice — populated from 2026-07-16 onwards
  // by recomputeNwDaily(). NULL on legacy rows (pre-migration) and on any
  // hypothetical future row written before fund_holdings has synced. Consumers
  // (e.g., a future Equity:Debt trend chart) should treat null as "skip point"
  // rather than "zero".
  mf_equity_inr: number | null;
  mf_debt_inr: number | null;
  nps_value: number;
  epf_estimate: number;
  total_nw: number;
  mf_gain_pct: number | null;
  mf_1d_change_inr: number | null;
  mf_1d_change_pct: number | null;
  nps_1d_change_inr: number | null;
  nps_1d_change_pct: number | null;
  created_at?: string;
  /**
   * Cumulative net MF deposits (purchases − redemptions) as of this
   * row's date, sourced from the union of `mf_contributions` and
   * `mf_transactions`. Enriched in `getOverviewData`; not stored in
   * `nw_daily`.
   *
   * WHY NOT USE `mf_invested`
   * ─────────────────────────
   * `mf_invested` reflects the CURRENT cost-basis snapshot from
   * `fund_holdings.invested_inr` — it's the same value on every
   * historical row before the day tracking began. That makes the
   * "cumulative deposits" curve on the MF Attribution chart flat
   * for the whole history-before-tracking, and step-up only on
   * days when a new Groww sync landed. This ledger-derived field
   * gives a truthful day-by-day curve going back as far as the
   * CAS covers.
   *
   * `undefined` when neither ledger table has rows (bootstrap
   * install); consumers should fall back to `mf_invested` in that
   * case.
   */
  mf_deposits_ledger?: number;
};

// nav_source values (see 2026-07-17-nps-pop-correction.sql for the audit
// tag added when a CAS paste reconciles the NPS state).
export type NavSource = "kotak" | "npsnav.in" | "cas_reconciliation";

// MF NAV source — the fund_holdings.nav_source column added in
// 2026-07-17-mf-nav-refresh.sql. Separate enum from NavSource
// (NPS-side) because the two never overlap: an MF row can only be
// one of the three MF values, an NPS row can only be one of the
// three NPS values. Keeping them distinct prevents accidental
// cross-writes (e.g., stamping 'kotak' onto an MF row).
//
// 'amfi' was added 2026-07-22 as the primary automated source (see
// lib/mf/amfiClient.ts and app/api/refresh-mf-nav/route.ts for the
// AMFI-primary / mfapi-fallback rationale). 'mfapi' is retained for
// rows the refresh route served from the fallback path — typically
// the T+1 overseas funds (ICICI Nasdaq, PPFAS Flexi Cap) for which
// AMFI carries only yesterday's date until mid-morning. 'groww'
// marks rows last touched by a manual Groww JSON paste.
export type MfNavSource = "amfi" | "mfapi" | "groww";

export type NpsState = {
  id: number;
  // 12-digit Permanent Retirement Account Number. Null on installations
  // that haven't done their first CAS paste yet — the paste flow seeds
  // it on first successful apply and validates on every subsequent
  // paste. Added 2026-07-17-cas-reconciliation.sql.
  pran: string | null;
  scheme_e_units: number;
  scheme_c_units: number;
  scheme_g_units: number;
  scheme_e_nav: number;
  scheme_c_nav: number;
  scheme_g_nav: number;
  scheme_e_nav_prev: number | null;
  scheme_c_nav_prev: number | null;
  scheme_g_nav_prev: number | null;
  nav_date: string | null;
  nav_updated_at: string | null;
  nav_source: NavSource | null;
  total_invested_inr: number;
  monthly_contribution_inr: number;
  alloc_e_pct: number;
  alloc_c_pct: number;
  alloc_g_pct: number;
  last_units_update: string;
};

export type EpfState = {
  id: number;
  balance_inr: number;
  monthly_contribution_inr: number;
  interest_rate_pct: number;
  last_verified_date: string;
  // Annual interest credit event — populated when the user records an
  // EPFO interest credit via the Settings page. Purely audit / display —
  // the actual amount is folded into balance_inr at recording time.
  last_interest_credit_date: string | null;
  last_interest_credit_amount_inr: number | null;
  // Lifetime split of balance_inr into "your money" vs "compounded
  // interest". Seeded from EPFO passbook PDFs (2026-07-17) and kept in
  // sync by the log/delete retirement_credits RPCs. Feeds the Overview
  // wealth-composition donut. Soft invariant:
  // lifetime_contribution_inr + lifetime_interest_inr = balance_inr.
  lifetime_contribution_inr: number;
  lifetime_interest_inr: number;
};

// ─── Retirement credits ledger ───────────────────────────────────────────

export type CreditSource = "EPF" | "NPS";
// Note: the `self` type was retired on Jul 17, 2026 because the user does not
// make voluntary top-ups to either EPF (no VPF) or NPS (no eNPS/D-Remit self
// contribution). The DB CHECK constraint still allows it for backward-compat,
// but the UI can no longer produce it. If self contributions start later,
// re-add it here and in the dropdowns.
export type CreditType = "payroll" | "interest";

/**
 * A single row in the `retirement_credits` table — one real EPFO/NPS
 * credit event as recorded manually via /credits or Settings. Source of
 * truth for attribution: `computeNwAttribution` (lib/nwAttribution.ts)
 * sums these instead of scanning day-of-month.
 *
 * Uniqueness: DB enforces UNIQUE(source, credit_date, credit_type) so
 * accidentally logging the same event twice is caught server-side.
 */
export type RetirementCredit = {
  id: number;
  source: CreditSource;
  credit_date: string;   // YYYY-MM-DD
  credit_type: CreditType;
  amount_inr: number;
  note: string | null;
  created_at: string;
};

export type Fund = {
  fund_code: string;
  fund_name: string;
  current_value_inr: number;
  invested_inr: number;
  cap_type: CapType;
  nav: number | null;
  nav_date: string | null;
  units: number | null;
  updated_at: string;
  one_day_change_inr: number | null;
  one_day_change_pct: number | null;
};

export type CapType = "large" | "mid" | "small" | "intl" | "debt";

export type FundHoldingDetail = {
  fund_code: string;
  isin: string;
  company_name: string;
  weighting_pct: number;
};

export type FundNonSecurityHolding = {
  fund_code: string;
  weighting_pct: number;
  category: string;
};

export type MasterSecurity = {
  isin: string;
  company_name: string;
  mcap_classification: string | null;
  macro_economic_sector: string | null;
  region: string | null;
};

export type ConfigMap = Record<string, string>;

// Aggregates
export type AllocationSlice = { name: string; value: number; key: string };
export type SectorSlice = { name: string; pct: number; companies: number; tier: "primary" | "secondary" };

// ─── Time-series analytics for the Overview page ─────────────────────────

export type PeriodKey = "1D" | "1W" | "1M" | "3M" | "YTD" | "1Y" | "ALL";

/**
 * A single Net Worth delta over a time window. Periods with no historical
 * anchor point (e.g., "1Y" when we only have 2 months of data) are simply
 * omitted from the results array — the UI iterates and skips.
 *
 * daysActual vs daysBack: the target lookback (e.g., 30 for 1M) may not
 * land exactly on a stored row (weekends, missed crons). We snap to the
 * most recent row on/before the target date, and expose the true days
 * covered so the tooltip can say "since 15 JUN (33 days ago)" instead of
 * pretending we hit exactly 30.
 */
export type NwDelta = {
  period: PeriodKey;
  deltaInr: number;
  deltaPct: number;
  refDate: string;
  daysActual: number;
};

/**
 * Liquidity split — how much of the net worth is touchable "tomorrow"
 * (MF, sellable any market day, T+1 credit) vs contractually locked
 * until a future age gate (NPS at 60, EPF at 58 + service-length rules).
 *
 * Intentional simplification: cash inside MF funds rolls up as liquid
 * with the fund, matching the fund-level classification we use everywhere
 * else. Partial NPS/EPF withdrawal rules (medical, housing, etc.) are
 * ignored — corpus stays classified as locked.
 */
export type LiquiditySplit = {
  liquid: number;      // = mf_value
  locked: number;      // = nps_value + epf_estimate
  total: number;
  liquidPct: number;
  lockedPct: number;
  breakdown: {
    mf: number;
    nps: number;
    epf: number;
  };
};

// NwAttribution type + computeNwAttribution implementation moved to
// lib/nwAttribution.ts so it can be called client-side by the range-
// aware SummaryStrip inside NWTrendChart. Re-exported here so existing
// server-side consumers don't need to update their imports.
export type { NwAttribution } from "./nwAttribution";

// Two-bucket asset allocation summary for the Overview page.
//
// Bucket rules (agreed w/ user):
//   Equity = MF funds where cap_type ∈ {large, mid, small, intl}
//          + NPS × alloc_e_pct
//   Debt   = MF funds where cap_type = 'debt' (includes Conservative Hybrid
//          + Short-Term Debt at fund-level, no holding-level split)
//          + NPS × (alloc_c_pct + alloc_g_pct)
//          + entire EPF corpus
//
// Cash inside funds is NOT disaggregated — it rolls up with whatever fund
// it lives in. This is intentional; user explicitly picked the fund-level
// approach and the "cash rolls into debt" default.
export type AssetSplit = {
  totalEquity: number;
  totalDebt: number;
  totalConsidered: number;      // equity + debt (≈ total_nw when all data present)
  equityPct: number;
  debtPct: number;
  breakdown: {
    mfEquity: number;           // Σ cap_type ∈ {large,mid,small,intl}
    mfDebt: number;             // Σ cap_type = 'debt'
    npsEquity: number;          // nps_value × alloc_e_pct
    npsDebt: number;            // nps_value × (alloc_c_pct + alloc_g_pct)
    epfDebt: number;            // epf_estimate (100% debt-like)
  };
};

// ─── Wealth composition: contributions vs gains ──────────────────────────
//
// Powers the 4-donut card on Overview. Each bucket answers: "of my
// current corpus in X, how much is money I put in, and how much is
// growth (market gain / interest earned)?"
//
// UNIFIED DONUT MODEL (positive AND negative gains)
// -------------------------------------------------
// Traditional pie-of-current-value breaks for negative-gain cases
// because "growth" is < 0 and doesn't fit as a slice. To keep the same
// donut shape in every state, we pick the denominator dynamically:
//
//   • Gain ≥ 0: total = current
//                slice1 = contributions              (positive-tint)
//                slice2 = gain = current - contribs  (positive-tint)
//
//   • Gain < 0: total = contributions   (larger than current)
//                slice1 = current               (positive-tint, "retained")
//                slice2 = loss = contribs - current  (danger-tint)
//
// Center label always reads:
//   "{current value}" + "{gain%}" (colored: green ≥ 0, red < 0)
//
// This means slices ALWAYS sum to a positive number, the donut ring
// stays visually consistent, and the red slice is impossible to miss
// on a losing position.
//
// EDGE CASES
// ----------
// • contributions == 0 (fresh account, no funds bought yet):
//     gainPct = 0 by definition; slice1 = 0, slice2 = current. Donut
//     shows 100% "growth" which is nonsensical but a valid render.
// • current == 0 AND contribs > 0 (fully wiped out — impossible in
//     practice but defended for math sanity):
//     loss = contribs; donut is 100% red. hero shows -100%.
export type CompositionSlice = {
  /** Human label — "Contributions", "Growth", "Retained", "Loss" */
  label: string;
  /** ₹ value of the slice */
  inr: number;
  /** Semantic role — used by the UI to pick color from the theme */
  role: "contribution" | "growth" | "retained" | "loss";
};

export type CompositionBucket = {
  /** "Total Net Worth" / "Mutual Funds" / "NPS" / "EPF" */
  label: string;
  /** Value shown in the donut centre */
  currentInr: number;
  /** Money you put in — from DB (invested / total_invested / lifetime_contribution) */
  contributionsInr: number;
  /** currentInr - contributionsInr. Positive = growth, negative = loss */
  gainInr: number;
  /** gainInr / contributionsInr as %. Null when contribs = 0 (avoid /0) */
  gainPct: number | null;
  /** Two slices, always summing to `max(currentInr, contributionsInr)` */
  slices: [CompositionSlice, CompositionSlice];
  /**
   * True if the underlying seed is a rough estimate rather than an
   * authoritative DB number. Currently only EPF (pre-FY25 opening
   * balance is assumed 100% contributions per user's Jul 17 decision).
   * UI shows a small "?" annotation on estimated buckets.
   */
  estimated: boolean;
};

export type WealthComposition = {
  nw: CompositionBucket;
  mf: CompositionBucket;
  nps: CompositionBucket;
  epf: CompositionBucket;
};

/**
 * The MF-only slice of a daily snapshot. Same shape as the MF columns of
 * NwRow, plus an `is_reconstructed` flag so consumers can tell "observed
 * from the daily Dhan sync" apart from "computed retroactively from CAS
 * transactions × mfapi.in NAV history".
 *
 * The observed rows come from `nw_daily`; the reconstructed rows from
 * `mf_daily_reconstructed`. `getOverviewData` merges them into a single
 * `mfHistory` array, preferring observed on overlap (which currently
 * doesn't happen — reconstruction stops the day before nw_daily starts).
 *
 * We intentionally DON'T bolt reconstructed rows onto `history: NwRow[]`
 * because reconstructed rows have no NPS/EPF/total_nw values, and the
 * dozens of consumers of `history` (NW deltas, wealth composition, YTD
 * anchors, …) would need per-consumer null-guards. Keeping them in a
 * separate array preserves NwRow's non-null invariants.
 */
export type MfDailyRow = Pick<
  NwRow,
  | "date"
  | "mf_value"
  | "mf_invested"
  | "mf_equity_inr"
  | "mf_debt_inr"
  | "mf_gain_pct"
  | "mf_1d_change_inr"
  | "mf_1d_change_pct"
  | "mf_deposits_ledger"
> & {
  is_reconstructed: boolean;
};

/**
 * The NPS-only slice of a daily snapshot. Analogous to `MfDailyRow`.
 *
 * Every row carries:
 *   • `nps_value`       — Σ(units held per scheme × NAV that day). For
 *     reconstructed rows we compute this from
 *     `nps_transactions` unit cumsum × `nps_nav_history`. For observed
 *     rows we prefer the value that was actually written to
 *     `nw_daily.nps_value` on that day (Kotak/npsnav.in refresh at
 *     the moment the row was written).
 *   • `nps_invested`    — cumulative net cash deposited into NPS through
 *     this date. Ledger truth from `nps_transactions` (contribution
 *     rows only; billing is a fee, switches are internal). Same
 *     definition regardless of observed vs reconstructed — the ledger
 *     is authoritative for both.
 *   • `nps_gain_pct`    — (value − invested) / invested × 100. Null when
 *     invested is 0 (pre-first-contribution). Denominator is invested,
 *     not value, so a 0-gain shows as 0% not divide-by-zero.
 *   • `is_reconstructed` — `true` for rows computed retroactively (pre
 *     the nw_daily tracking window), `false` for observed rows.
 *
 * WHY NOT extend NwRow with these
 * ───────────────────────────────
 * Same reasoning as `MfDailyRow`: reconstructed rows have no MF/EPF/
 * total_nw values, and extending NwRow would blur its non-null invariants
 * for the dozens of consumers of `history`. Separate array preserves
 * NwRow's contract.
 */
export type NpsDailyRow = {
  date: string;
  nps_value: number;
  nps_invested: number;
  nps_gain_pct: number | null;
  is_reconstructed: boolean;
};

export type OverviewData = {
  latest: NwRow | null;
  prev: NwRow | null;
  history: NwRow[];
  /**
   * MF-only daily series covering the full available window (reconstructed
   * pre-tracking rows + observed nw_daily rows). Powers the MF Growth
   * chart's Jan → today story. Falls back to `history`-derived rows
   * when the reconstruction tables are empty or missing.
   */
  mfHistory: MfDailyRow[];
  /**
   * NPS-only daily series. Reconstructed from `nps_nav_history` ×
   * `nps_transactions` unit cumsum for the pre-tracking window
   * (~Apr 2024 → the day before nw_daily starts), then observed
   * nw_daily rows take over for recent days. Empty when the
   * migrations aren't applied yet.
   */
  npsHistory: NpsDailyRow[];
  /**
   * Tier I NPS money-weighted return (XIRR), computed from every real
   * contribution/withdrawal in `nps_transactions` plus today's value as
   * the terminal flow. Excludes CRA billing fees and inter-scheme
   * switches (see computeNpsXirr for the full rationale). Decimal form —
   * multiply by 100 for a percentage. Null until enough ledger data
   * exists to solve a rate (needs ≥2 distinct dates and both a negative
   * and positive flow — effectively "at least one contribution ingested").
   */
  npsXirr: number | null;
  nps: NpsState | null;
  epf: EpfState | null;
  fundCount: number;
  lastSync: string | null;
  config: ConfigMap;
  assetSplit: AssetSplit | null;
  nwDeltas: NwDelta[];               // Multi-period NW change chips
  liquiditySplit: LiquiditySplit | null;
  // NW attribution is now computed range-aware, client-side, by
  // NWTrendChart's SummaryStrip from `credits` + slice of `history`.
  // See lib/nwAttribution.computeNwAttribution — the field previously
  // rendered here was a fixed all-time snapshot for the deleted
  // NwAttributionCard.
  credits: RetirementCredit[];       // For attribution + Overview drill-in
  wealthComposition: WealthComposition | null;
  /**
   * Current level / all-time-high / 52-week-high / 3-month-high for the
   * six tracked market indices. Empty array before the
   * 2026-07-23-index-levels.sql migration is applied, or before the
   * first manual refresh on /sync (app/api/refresh-index-levels).
   */
  indexLevels: IndexLevelRow[];
};

/**
 * One row from `index_levels` — see migrations/2026-07-23-index-levels.sql
 * and lib/indexLevels/yahooClient.ts for the full data-source rationale
 * (Yahoo Finance chart API, close-based ATH/52w/3m, verified ticker map).
 */
export type IndexLevelRow = {
  index_code: string;
  display_name: string;
  currency: "INR" | "USD";
  current_level: number;
  as_of_date: string;
  /** Previous trading day's close — powers the "Today" % column on the
   *  Overview page. Nullable because pre-2026-07-24 rows didn't have
   *  this and won't until the next refresh backfills them, and because
   *  a data gap on a listing debut / first bar can legitimately produce
   *  a null. UI renders "—" in that case. */
  previous_close: number | null;
  previous_close_date: string | null;
  ath_level: number;
  ath_date: string;
  high_52w_level: number;
  high_52w_date: string;
  high_3m_level: number;
  high_3m_date: string;
  updated_at: string;
};

/**
 * Fetch all rows from `index_levels`, ordered by index_code (stable,
 * arbitrary — the UI re-orders into its preferred display sequence).
 *
 * AUTO-REFRESH ON STALENESS
 * -------------------------
 * If the freshest cached row is older than INDEX_LEVELS_STALE_MS (15
 * min), triggers `refreshIndexLevels()` inline BEFORE reading, so the
 * page render blocks briefly (~1-3s) but always displays current data.
 * Alternative background-refresh-with-stale-serve was considered and
 * rejected: it would silently show stale numbers on the load that
 * triggered the refresh (users would need to reload again to see
 * fresh data). Inline blocking on staleness matches the intuitive
 * expectation from "auto-refresh on page load".
 *
 * The refresh core is imported and called directly rather than via a
 * self-HTTP round-trip to the /api/refresh-index-levels route — same
 * semantics, no serialization overhead, no risk of a Vercel/edge
 * routing issue breaking the auto-refresh loop.
 *
 * Failures during auto-refresh are swallowed (logged only) so a bad
 * Yahoo response doesn't prevent the page from rendering; the user
 * just sees the slightly-stale-but-existing data and can retry with
 * the manual /sync button later.
 *
 * Degrades to an empty array before the migration is applied, matching
 * the missing-table convention used throughout this file (see
 * fetchMfLedger / fetchNpsLedger for the same 42P01/PGRST205 handling).
 */
async function fetchIndexLevels(): Promise<IndexLevelRow[]> {
  // First read — we always want the current cached snapshot in hand
  // before deciding whether to refresh (so we can still render on a
  // Yahoo failure by returning the stale rows).
  const initial = await sb.from("index_levels").select("*").order("index_code");
  if (initial.error) {
    const code = (initial.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] index_levels table missing — apply migration " +
          "2026-07-23-index-levels.sql, then click Refresh on /sync."
      );
      return [];
    }
    throw initial.error;
  }
  const cachedRows = (initial.data ?? []) as unknown as IndexLevelRow[];

  // Compute freshest updated_at across all rows; if the table is empty
  // (first-ever load, pre-refresh), treat as maximally stale to trigger
  // the initial populate. Same for a legitimately-stale snapshot.
  const freshestMs =
    cachedRows.length === 0
      ? 0
      : cachedRows.reduce<number>((max, r) => {
          const t = Date.parse(r.updated_at);
          return Number.isFinite(t) && t > max ? t : max;
        }, 0);
  const ageMs = Date.now() - freshestMs;

  // Import lazily to avoid pulling the Yahoo client into any read path
  // that never triggers a refresh (keeps cold-start bundle lean).
  if (ageMs > INDEX_LEVELS_STALE_MS) {
    try {
      const { refreshIndexLevels } = await import("./indexLevels/refresh");
      await refreshIndexLevels();
      // Re-read to pick up the freshly-upserted rows. Same select, no
      // staleness check this time (we JUST wrote them).
      const refreshed = await sb
        .from("index_levels")
        .select("*")
        .order("index_code");
      if (!refreshed.error) {
        return (refreshed.data ?? []) as unknown as IndexLevelRow[];
      }
      // Refresh succeeded but re-read failed — fall through and return
      // the stale rows we already had; user still sees something.
      console.warn(
        "[queries] index_levels re-read after auto-refresh failed:",
        refreshed.error
      );
    } catch (err) {
      // Yahoo hiccup / upsert failure — log and serve the stale data.
      // The manual /sync refresh button remains available if the
      // problem persists.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[queries] index_levels auto-refresh failed (age ${Math.round(
          ageMs / 60000
        )} min): ${msg}. Serving cached snapshot.`
      );
    }
  }

  return cachedRows;
}

// ─── Portfolio page (extra analytical types) ─────────────────────────────

/**
 * Headline totals at the top of the Portfolio page — mirrors the summary
 * chip pattern from the Overview page so users see the same "invested →
 * current → gain" story before drilling into fund-level detail.
 *
 * 1D aggregate: sum of one_day_change_inr across all funds (Groww's per-
 * fund NAV-pair delta). Provider chip, not snapshot diff — matches the
 * Overview MF card exactly. Null when no fund has a persisted 1D value
 * yet (fresh install before the first refresh cycle publishes a nav_prev
 * baseline).
 */
export type PortfolioHeadline = {
  invested: number;
  current: number;
  gainInr: number;
  gainPct: number;
  oneDayInr: number | null;
  oneDayPct: number | null;
  fundCount: number;
};

/**
 * A single aggregated look-through position — one row per ISIN,
 * summing (fund_value × weighting_pct/100) across all funds that hold
 * that ISIN.
 *
 * `n_funds` powers both the top-stocks list (info) and the cross-fund
 * overlap list (concentration signal). fund_codes is preserved so the
 * UI can show "Held in HDFC_FC, PPFAS_FC, UTI_N50" tooltips without
 * a second round trip.
 *
 * effective_inr is denominated in ₹; pct_of_mf is that as a share of
 * total MF value (mfTotal). Non-security holdings (cash, gold, REITs
 * bucketed elsewhere) are NOT included in this aggregation — they live
 * in fund_non_security_holdings.
 */
export type LookthroughStock = {
  isin: string;
  company_name: string;
  effective_inr: number;
  pct_of_mf: number;
  n_funds: number;
  fund_codes: string[];
  cap_type: string | null;      // from master.mcap_classification (Large/Mid/Small/Micro/…)
  sector: string | null;        // from master.macro_economic_sector
};

/**
 * Sector concentration — top-N sectors with a severity band for the
 * warning strip. Severity thresholds are baked in code (20/25/30) per
 * HANDOVER §15.2; move to portfolio_config only if the user wants to
 * tune them.
 *
 * `safe`     → < 20% (green)
 * `info`     → 20–25% (blue)
 * `warning`  → 25–30% (amber)
 * `alert`    → > 30% (red)
 */
export type SectorSeverity = "safe" | "info" | "warning" | "alert";
export type SectorConcentration = {
  name: string;
  pct: number;
  companies: number;
  severity: SectorSeverity;
};

export type PortfolioData = {
  funds: Fund[];
  topHoldingsByFund: Record<string, FundHoldingDetail[]>;
  assetAllocation: AllocationSlice[];
  /**
   * Top-level MF composition: Indian equity vs Debt vs International.
   * Sums to `mfTotal`. Drills into the MF slice of `assetAllocation`
   * one level: "of my MF portfolio, how much is Indian equity vs
   * fixed-income vs foreign?".
   *
   * Debt/Intl funds contribute their full fund value to their bucket
   * (skip look-through); every other fund is looked through by stock
   * so a "large-cap" fund holding 8% US stocks reports that 8% as
   * International here (not as Large).
   */
  mfComposition: AllocationSlice[];
  /**
   * Within-Indian-equity Large:Mid:Small split. Sums to 100% of the
   * Indian equity total (which is `mfComposition.indian_equity`, NOT
   * mfTotal). Look-through, per-stock, using the classification
   * convention:
   *   • master.source = nse-nifty50      → 100% Large
   *   • master.source = nse-niftynext50  → 100% Large  (see NN50 note)
   *   • master.mcap_classification = Mid → 100% Mid
   *   • Small / Micro / Nano             → 100% Small
   *
   * NN50 convention (2026-07-27): NN50 stocks count as 100% Large in
   * the look-through split. Previously we applied a 75:25 (large:mid)
   * blend that mirrored one SEBI reading, but the user's operational
   * view now treats the entire Nifty Next 50 tier as large cap for
   * portfolio-cap analysis. The sub-bucket tagging (LargeN50 vs
   * LargeNN50 in the classification card) is preserved so counts and
   * drill-downs still distinguish the two tiers — only the weighting
   * in the look-through totals changed.
   */
  indianEquityCapSplit: AllocationSlice[];
  /**
   * Sum of Large + Mid + Small buckets, in ₹. Used as the donut
   * center total for the `indianEquityCapSplit` view (denominator
   * for the % labels). Kept separately so consumers don't have to
   * re-sum the slice array.
   */
  indianEquityTotal: number;
  sectorExposure: SectorSlice[];
  totalNw: number;
  mfTotal: number;
  // ── New (2026-07-17) ──
  headline: PortfolioHeadline;
  /** Top 10 aggregated look-through positions (by effective_inr desc) */
  topStocks: LookthroughStock[];
  /**
   * All stocks held via 2+ funds, sorted by n_funds desc then
   * effective_inr desc. Client filters to 3+/4+/5+ via a UI pill.
   * Returned server-side already because the join is non-trivial and
   * we want the entire filter set on the client to avoid round-trips
   * when the user toggles filters.
   */
  crossFundOverlap: LookthroughStock[];
  /**
   * Top-3 sectors with severity flags, for the concentration warning
   * strip. Sectors below the top 3 don't warrant the strip's attention
   * (they're on the SectorExposure tiles anyway).
   */
  sectorConcentration: SectorConcentration[];
  /**
   * Per-sector drill-down: sector name → all look-through stocks in
   * that sector, pre-sorted by effective_inr desc. Powers the modal
   * that opens when a user clicks a sector tile.
   *
   * Keyed by macro_economic_sector name (the same string used in
   * SectorSlice.name) so the UI can join them without a translation
   * layer. Every stock present in `lookthrough` with a non-null sector
   * appears in exactly one bucket here.
   */
  stocksBySector: Record<string, LookthroughStock[]>;
};

export type FundResyncStatus = {
  fund_code: string;
  fund_name: string;
  cap_type: CapType;
  current_value_inr: number;
  updated_at: string;
  coverage_pct: number;                // security + non-security (total)
  security_coverage_pct: number;       // fund_holdings_detail only
  nonsec_coverage_pct: number;         // fund_non_security_holdings only
  state: "idle" | "syncing" | "error";
  unresolved_isins?: string[];
  detail_rows: number;                 // fund_holdings_detail rows
  nonsec_rows: number;                 // fund_non_security_holdings rows
  portfolio_date: string | null;       // most recent portfolio_date from either table
  unresolved_count: number;            // # holdings Dhan returned that we couldn't classify
  unresolved_weight_pct: number;       // total weight of unresolved holdings
  unknown_types_count: number;         // # holdings with unknown holding_type code
};

export type SyncData = {
  lastSync: string | null;
  fundCount: number;
  totalDetailRows: number;
  fundResync: FundResyncStatus[];
  /**
   * MF NAV summary — powers the "Mutual Funds" mini-panel inside the
   * unified RefreshNavsCard. Null on brand-new installations where
   * fund_holdings hasn't been seeded yet (first Groww paste creates it).
   *
   * Field semantics:
   *   • nav_updated_at → max(fund_holdings.nav_updated_at) across all
   *     rows. What the "Last refreshed Xm ago" ticker reads.
   *   • nav_date → the most COMMON nav_date across funds (see
   *     refresh-mf-nav's headline-date-picking comment). NOT max, because
   *     a single T+2 FoF outlier shouldn't drag the whole card's label.
   *   • nav_source → most recent nav_source across funds. If mixed
   *     (some mfapi + some groww), we pick whichever wrote most recently
   *     (by nav_updated_at). Purely a display badge.
   *   • total_value_inr → sum(current_value_inr) — matches the MF card
   *     hero number on the Overview page.
   *   • fund_count → total rows.
   *   • stale_fund_count → funds whose nav_date lags the headline
   *     nav_date. Rendered as a small "1 stale" pill on the card.
   *   • has_prev → true if AT LEAST ONE fund has a non-null nav_prev,
   *     used to gate the "1D delta available after next refresh"
   *     first-run hint.
   */
  mf: {
    nav_date: string | null;
    nav_updated_at: string | null;
    nav_source: MfNavSource | null;
    total_value_inr: number;
    fund_count: number;
    stale_fund_count: number;
    has_prev: boolean;
  } | null;
  nps: {
    nav_date: string | null;
    nav_updated_at: string | null;
    nav_source: NavSource | null;
    nps_value_inr: number;
    scheme_e_nav: number | null;
    scheme_c_nav: number | null;
    scheme_g_nav: number | null;
    has_prev: boolean;
  } | null;
  /**
   * Current / ATH / 52w-high / 3m-high for the six tracked market
   * indices — powers RefreshIndexLevelsCard on /sync. Empty array
   * before migration 2026-07-23-index-levels.sql is applied or before
   * the first refresh click.
   */
  indexLevels: IndexLevelRow[];
  /**
   * Cap-classification refresh state — feeds the "Refresh cap
   * classifications" card on the Sync page. Even on a fresh install
   * with no prior sync, this is always populated: `lastSyncedAt` is
   * null and the counts come from the current DB state so the user
   * can see the starting distribution before clicking the button.
   *
   * Also carries per-bucket stock lists so the tile-click drill-down
   * modal can render without a second round-trip. ~2,400 India rows
   * + 520 US rows keeps the payload well under 500KB — cheap in
   * exchange for instant modal opens on the Sync page which users
   * hit infrequently anyway.
   */
  capClassification: {
    /** ISO timestamp of the last successful NSE refresh, or null. */
    lastSyncedAt: string | null;
    /**
     * Current distribution of mcap_classification values. India
     * buckets (Large/Mid/Small/Micro/Nano) come from Nifty index
     * membership; `US` is the flat bucket for every US equity row
     * (with SP500 / Nasdaq 100 detail carried in
     * `stocks.US[].index_membership`).
     *
     * Large is split by sub-bucket via the `source` column:
     *   • source = "nse-nifty50"     → LargeN50      (mega-caps, ranks 1-50)
     *   • source = "nse-niftynext50" → LargeNN50     (ranks 51-100)
     *   • anything else Large        → LargeOverride (see below)
     *
     * LargeOverride captures Large-tagged rows whose `source` doesn't
     * match either NSE index CSV — almost always manual overrides via
     * scripts/set-cap-override.mjs (demerger entities, spin-offs, and
     * newly-listed stocks not yet in NSE's Nifty CSVs). Previously
     * these were silently parked into LargeNN50, which polluted the
     * count against the exact NSE definition (NN50 = 50 stocks by
     * construction). Keeping them in their own bucket also matters
     * because refresh sweeps skip them (source is non-NSE), so users
     * can see at a glance how many rows are shielded from the auto-
     * refresh.
     *
     * Invariant: LargeN50 + LargeNN50 + LargeOverride == Large.
     */
    counts: {
      Large: number;
      LargeN50: number;
      LargeNN50: number;
      LargeOverride: number;
      Mid: number;
      Small: number;
      Micro: number;
      Nano: number;
      US: number;
      /** Rows still without a bucket (usually pre-classification). */
      unclassified: number;
    };
    /**
     * Stock list per bucket — powers the drill-down modal. Keyed by
     * the same names as `counts` (minus `Large` — the split view
     * uses LargeN50/LargeNN50/LargeOverride, and `unclassified` —
     * those rows are typically debt bonds and other non-equity noise
     * we don't want to surface).
     */
    stocks: {
      LargeN50: CapStock[];
      LargeNN50: CapStock[];
      LargeOverride: CapStock[];
      Mid: CapStock[];
      Small: CapStock[];
      Micro: CapStock[];
      Nano: CapStock[];
      US: CapStock[];
    };
    /**
     * Rows whose `confidence` column contains the substring "manual" —
     * treated as sticky by the NSE refresh (never reclassified). Used
     * cases so far: demerger/spin-off entities not yet in NSE index
     * CSVs (Vedanta demerger group), REITs pinned for reference, and
     * ISIN-verified bond CDs backfilled from an external source.
     *
     * Surfaced on the Sync page so the user knows how many rows are
     * shielded from the auto-refresh. Grows via
     * `scripts/set-cap-override.mjs`.
     */
    manualOverrideCount: number;
  };
  /**
   * Full EPF and NPS state rows — fed to LogCreditEventCard so the amount
   * input can show a source+type-aware placeholder (EPF payroll hint,
   * EPF interest hint, NPS monthly-contribution default) and the success
   * message can mention the E:C:G alloc split on NPS credits.
   *
   * These are separate from the summary `nps` object above because
   * `RefreshNavsCard` needs derived fields (nps_value_inr, has_prev) that
   * aren't on the raw table row, while `LogCreditEventCard` needs raw
   * fields (alloc_e_pct, monthly_contribution_inr) that aren't in the
   * summary. Two shapes, one round-trip.
   *
   * Both are null on brand-new installations that haven't seeded these
   * state rows yet — the card degrades gracefully to a generic "0"
   * placeholder in that case.
   */
  epfState: EpfState | null;
  npsState: NpsState | null;
};

/**
 * One row in the cap-detail modal. Fields chosen to match what the
 * `master_security_classification` table stores natively — no
 * portfolio-side derived fields (like effective_inr) because this is
 * a master-only view (not everything here is actually held).
 */
export type CapStock = {
  isin: string;
  symbol: string | null;
  company_name: string;
  raw_sector: string | null;
  /** For US: "SP500" | "NASDAQ100" | "SP500+NASDAQ100" | "". For India: null. */
  index_membership: string | null;
  /** e.g. "nse-nifty100" for India; "iShares (IVV + Nasdaq 100)" for US. */
  source: string | null;
};

export type SettingsData = {
  nps: NpsState | null;
  epf: EpfState | null;
  config: ConfigMap;
  rotation: Record<string, string>;
  fundCodes: string[];
  v6StartDate: string | null;
};

/**
 * Rolling 12-month view for the /credits page.
 *
 * Window = today.getUTCFullYear/getUTCMonth minus 12 months, clipped to
 * the start-of-month. This gives us 12 full months back plus the current
 * partial month, matching "since about a year ago" more intuitively than
 * a strict 365-day slide.
 *
 * `credits` returned in descending date order (most recent first) for
 * direct rendering.
 */
/**
 * Unified ledger row shape covering BOTH `mf_contributions` (Groww
 * paste) and `mf_transactions` (MFCentral eCAS ingest).
 *
 * WHY ONE TYPE INSTEAD OF TWO
 * ───────────────────────────
 * The Credits log, Overview attribution, and FundDetailsModal all want
 * to render "every event that moved money into/out of an MF fund" in a
 * consistent way. Rather than force each consumer to case on which
 * table a row came from, we normalise at query time and stamp a
 * `source` field. Consumers that care about provenance (e.g. render a
 * "CAS" vs "Groww" badge) branch on `source`; consumers that don't
 * (bucket-by-month sums, chart cumsums) treat the union as flat.
 *
 * FIELD PROVENANCE
 * ────────────────
 *   Common fields present on both sources:
 *     • id            — order_id (Groww) or tx_hash (CAS)
 *     • fund_code, scheme_name, order_date, amount_inr, units, nav
 *
 *   Groww-only (null on CAS rows):
 *     • order_status   — "COMPLETED" / "PENDING" / etc. CAS transactions
 *                        by definition are settled events; we surface
 *                        this as null (not "COMPLETED") so the "N
 *                        pending" banner logic stays Groww-scoped.
 *     • placed_at      — click timestamp; CAS only has T+n settlement.
 *     • completion_date — units-allotted date; CAS doesn't record it
 *                        separately (the tx_date IS the settlement
 *                        date on the RTA side).
 *
 *   CAS-only (null on Groww rows unless enriched later):
 *     • folio_number   — Groww's `mf_contributions.folio_number` DOES
 *                        exist in the DB, but the current select
 *                        omits it. It's included here so a future
 *                        select-widen doesn't require a type change.
 */
export type MfLedgerEntry = {
  id: string;
  /** Ingest mechanism — how this row landed in the DB:
   *   • 'groww'  — parsed from Groww's own order-history JSON (lives
   *                in mf_contributions)
   *   • 'cas'    — parsed from MFCentral eCAS Excel (mf_transactions
   *                with source='mfcentral_cas'). RTA-authoritative;
   *                the row has been reconciled with the AMC's records.
   *   • 'manual' — hand-typed via the /sync manual form OR parsed from
   *                an INDmoney JSON paste (mf_transactions with
   *                source='manual'). Not yet CAS-reconciled — the row
   *                represents the user's best-known information, may
   *                get overwritten/superseded by a future CAS import.
   * Distinct from `platform` (WHERE the trade was placed) — see
   * lib/mf/platform.ts. A single trade can be CAS-source + INDmoney-
   * platform (post-settlement view) or manual-source + INDmoney-
   * platform (pre-settlement view before CAS reflects it). */
  source: "groww" | "cas" | "manual";
  fund_code: string | null;
  scheme_name: string | null;
  /** Normalised uppercase order type. See mapping in `mapTxTypeToOrderType`. */
  order_type: string | null;
  order_status: string | null;
  order_date: string;
  placed_at: string | null;
  /**
   * Date (YYYY-MM-DD) the user actually clicked Buy — distinct from
   * `order_date` which stores the NAV date (day whose NAV was applied
   * to allot units). Only populated for manual/INDmoney rows where
   * INDmoney's Subtitle1 (click date) differs from the resolved NAV
   * date; null on Groww rows (they use `placed_at`'s time-included
   * timestamp instead), CAS rows (no click-date info in the CAS
   * payload), and same-day manual entries where placed==NAV would be
   * redundant to store. See migration 2026-07-24-mf-transactions-
   * placed-date.sql for the schema-side rationale.
   */
  placed_date: string | null;
  completion_date: string | null;
  amount_inr: number | null;
  units: number | null;
  nav: number | null;
  folio_number: string | null;
  /** WHERE the order was actually placed (Groww, INDmoney, ICICI
   *  Prudential, etc.) — see lib/mf/platform.ts for the vocabulary.
   *  Null for rows that pre-date the platform column or came in via
   *  MFCentral CAS (which doesn't carry originating-platform info in
   *  its payload). */
  platform: string | null;
};

/**
 * Legacy alias — old name from when only the Groww source existed.
 * Keep for one release cycle so external callers (if any) don't break;
 * new code should use `MfLedgerEntry` directly.
 */
export type MfContribution = MfLedgerEntry;

export type CreditsPageData = {
  credits: RetirementCredit[];
  currentMonthByType: {
    epfPayroll: boolean;
    npsPayroll: boolean;
  };
  /**
   * All MF ledger entries, ordered by order_date DESC. Union of
   *   • Groww orders (`mf_contributions`)
   *   • CAS transactions (`mf_transactions`, source='mfcentral_cas')
   *
   * The two tables are guaranteed disjoint by construction — the
   * (one-time, now retired) CAS ingest deleted overlapping
   * mf_contributions rows within its covered window before writing,
   * so naive concatenation cannot produce duplicates.
   *
   * Volume stays modest even after years of ingestion — daily
   * purchase + lumpsum activity yields ~500 rows/year, comfortably within a
   * single PostgREST payload without pagination.
   */
  mfLedger: MfLedgerEntry[];
  /**
   * Sums for the headline strip at the top of the Credits page.
   * All three are current calendar month, inclusive of pending
   * orders (order_status != COMPLETED) — a placed-but-not-yet-
   * allotted MF purchase still represents money committed.
   */
  currentMonthTotals: {
    epfInr: number;
    npsInr: number;
    mfInr: number;
  };
  /**
   * Orders with order_status other than COMPLETED — used to render
   * the "N orders in progress" banner above the log so the user
   * knows some rows will fill in later.
   */
  mfPendingCount: number;
};

// ─── Fetch primitives ──────────────────────────────────────────────────────

async function fetchConfigMap(): Promise<ConfigMap> {
  const { data, error } = await sb
    .from("portfolio_config")
    .select("key,value");
  if (error) throw error;
  const map: ConfigMap = {};
  for (const row of data ?? []) map[row.key] = row.value;
  return map;
}

// ─── Overview analytics helpers ────────────────────────────────────────────

/**
 * Find the row in `history` whose date is closest to but not after
 * `targetTimestamp`. History is expected to be sorted ascending by date.
 * Returns null when no row qualifies (e.g., target predates our data).
 */
function findRowOnOrBefore(
  history: NwRow[],
  targetTimestamp: number
): NwRow | null {
  let best: NwRow | null = null;
  for (const row of history) {
    const t = new Date(row.date).getTime();
    if (t > targetTimestamp) break;
    best = row;
  }
  return best;
}

/**
 * YTD anchor = first row of the current calendar year. Falls back to the
 * first available row when we started tracking mid-year (so "YTD" is
 * transparent about "since we started" instead of pretending we have
 * Jan 1 data).
 */
function findYtdAnchor(history: NwRow[]): NwRow | null {
  if (history.length === 0) return null;
  const latestYear = new Date(history[history.length - 1].date).getUTCFullYear();
  for (const row of history) {
    if (new Date(row.date).getUTCFullYear() >= latestYear) return row;
  }
  return history[0];
}

function computeNwDeltas(history: NwRow[]): NwDelta[] {
  if (history.length < 2) return [];
  const latest = history[history.length - 1];
  const latestTs = new Date(latest.date).getTime();
  const results: NwDelta[] = [];
  const DAY_MS = 86400000;

  // Fixed-window periods. Order matches the visual order of chips.
  const windows: { key: PeriodKey; daysBack: number }[] = [
    { key: "1D", daysBack: 1 },
    { key: "1W", daysBack: 7 },
    { key: "1M", daysBack: 30 },
    { key: "3M", daysBack: 90 },
    { key: "1Y", daysBack: 365 },
  ];

  for (const { key, daysBack } of windows) {
    const ref = findRowOnOrBefore(history, latestTs - daysBack * DAY_MS);
    if (!ref || ref.date === latest.date) continue;
    const deltaInr = latest.total_nw - ref.total_nw;
    const deltaPct = ref.total_nw > 0 ? (deltaInr / ref.total_nw) * 100 : 0;
    const daysActual = Math.round((latestTs - new Date(ref.date).getTime()) / DAY_MS);
    results.push({ period: key, deltaInr, deltaPct, refDate: ref.date, daysActual });
  }

  // YTD — insert before "ALL" to keep temporal ordering.
  //
  // Strict definition: YTD is a financial term of art meaning "from Jan 1
  // of the current year". We only render the chip when the anchor row is
  // actually in January (or earlier — a Dec-31-prior-year row counts as a
  // near-Jan-1 baseline). If someone started tracking mid-year, YTD stays
  // hidden and the ALL chip covers the same information honestly.
  const ytdRef = findYtdAnchor(history);
  if (ytdRef && ytdRef.date !== latest.date) {
    const anchorDate = new Date(ytdRef.date);
    const anchorYear = anchorDate.getUTCFullYear();
    const anchorMonth = anchorDate.getUTCMonth();
    const latestYear = new Date(latest.date).getUTCFullYear();
    const isTrueYtd =
      anchorYear < latestYear ||
      (anchorYear === latestYear && anchorMonth === 0);
    if (isTrueYtd) {
      const deltaInr = latest.total_nw - ytdRef.total_nw;
      const deltaPct = ytdRef.total_nw > 0 ? (deltaInr / ytdRef.total_nw) * 100 : 0;
      const daysActual = Math.round((latestTs - new Date(ytdRef.date).getTime()) / DAY_MS);
      results.push({ period: "YTD", deltaInr, deltaPct, refDate: ytdRef.date, daysActual });
    }
  }

  // ALL — first row we have. Suppressed when the anchor row would be
  // identical to another chip's anchor:
  //   • matches 1Y anchor → we already have a year of history, "ALL"
  //     wouldn't add information
  //   • matches YTD anchor → common on fresh installs where the earliest
  //     row is inside the current year, so YTD covers the same ground
  //
  // Once history spans multiple years, YTD (this year only) and ALL
  // (everything) diverge naturally and both chips will render.
  const first = history[0];
  if (first.date !== latest.date) {
    const daysActual = Math.round((latestTs - new Date(first.date).getTime()) / DAY_MS);
    const has1Y = results.find((r) => r.period === "1Y");
    const hasYtd = results.find((r) => r.period === "YTD");
    const collidesWith1Y = has1Y && Math.abs(has1Y.daysActual - daysActual) <= 30;
    const collidesWithYtd = hasYtd && hasYtd.refDate === first.date;
    if (!collidesWith1Y && !collidesWithYtd) {
      const deltaInr = latest.total_nw - first.total_nw;
      const deltaPct = first.total_nw > 0 ? (deltaInr / first.total_nw) * 100 : 0;
      results.push({ period: "ALL", deltaInr, deltaPct, refDate: first.date, daysActual });
    }
  }

  return results;
}

function computeLiquiditySplit(latest: NwRow | null): LiquiditySplit | null {
  if (!latest) return null;
  const liquid = latest.mf_value;
  const locked = latest.nps_value + latest.epf_estimate;
  const total = liquid + locked;
  if (total <= 0) return null;
  return {
    liquid,
    locked,
    total,
    liquidPct: (liquid / total) * 100,
    lockedPct: (locked / total) * 100,
    breakdown: {
      mf: latest.mf_value,
      nps: latest.nps_value,
      epf: latest.epf_estimate,
    },
  };
}

/**
 * Build a single CompositionBucket from raw contribution + current values.
 *
 * Handles the unified donut model (see WealthComposition type header for
 * the full derivation): the two returned slices always sum to a positive
 * number, regardless of whether the position is up or down.
 *
 *   Gain ≥ 0: slices = [Contributions, Growth]  · total = current
 *   Gain < 0: slices = [Retained,      Loss  ]  · total = contribs
 *
 * The `estimated` flag surfaces buckets whose contribution seed is a
 * best-effort estimate rather than an authoritative DB number — the UI
 * shows a small "?" annotation so the user knows to take that pie's
 * split with a grain of salt. Currently only EPF is marked estimated
 * (per user's Jul 17 decision to treat pre-FY25 opening balance as
 * 100% contributions until older passbooks are uploaded).
 */
function buildCompositionBucket(input: {
  label: string;
  currentInr: number;
  contributionsInr: number;
  estimated: boolean;
}): CompositionBucket {
  const currentInr = Math.max(0, input.currentInr); // clamp negatives to 0
  const contributionsInr = Math.max(0, input.contributionsInr);
  const gainInr = currentInr - contributionsInr;
  const gainPct =
    contributionsInr > 0 ? (gainInr / contributionsInr) * 100 : null;

  let slices: [CompositionSlice, CompositionSlice];
  if (gainInr >= 0) {
    slices = [
      { label: "Contributions", inr: contributionsInr, role: "contribution" },
      { label: "Growth", inr: gainInr, role: "growth" },
    ];
  } else {
    // gainInr is negative; loss = abs(gain) = contribs - current
    slices = [
      { label: "Retained", inr: currentInr, role: "retained" },
      { label: "Loss", inr: contributionsInr - currentInr, role: "loss" },
    ];
  }

  return {
    label: input.label,
    currentInr,
    contributionsInr,
    gainInr,
    gainPct,
    slices,
    estimated: input.estimated,
  };
}

/**
 * Compute the 4-donut wealth composition from the same data already
 * fetched by getOverviewData. Kept as a separate function (rather than
 * inlined in getOverviewData) so it can be unit-tested and so the
 * inputs are explicit.
 *
 * MF contributions: sum of fund_holdings.invested_inr — accurate to
 *   the paisa because Groww tracks lifetime invested per fund.
 * MF current: latest nw_daily.mf_value if present (matches headline
 *   exactly), else sum(fund_holdings.current_value_inr) as fallback.
 * NPS contributions: nps_state.total_invested_inr — same lifetime
 *   accuracy.
 * NPS current: latest nw_daily.nps_value.
 * EPF contributions: epf_state.lifetime_contribution_inr (seeded from
 *   PDFs, kept in sync by the ledger RPCs). Marked ESTIMATED because
 *   pre-FY25 opening balance is assumed 100% contributions.
 * EPF current: epf_state.balance_inr.
 * NW: sum of the three buckets.
 */
function computeWealthComposition(input: {
  latest: NwRow | null;
  nps: NpsState | null;
  epf: EpfState | null;
  funds: Array<{ current_value_inr: number | null; invested_inr: number | null }>;
}): WealthComposition | null {
  // Bail if we don't have enough data to render anything meaningful.
  // Fresh install with no funds / no EPF seed → return null; the UI
  // shows a "no data yet" placeholder rather than a bunch of empty
  // donuts.
  if (!input.epf && !input.nps && input.funds.length === 0) return null;

  // ── MF bucket ──
  // Prefer latest.mf_value for the current-value read because that's
  // what the headline card shows — using the same source keeps the
  // headline and the donut in perfect agreement. Fall back to summing
  // fund_holdings if nw_daily hasn't been recomputed yet (very rare;
  // recomputeNwDaily runs after every sync).
  const mfInvested = input.funds.reduce(
    (sum, f) => sum + (f.invested_inr ?? 0),
    0
  );
  const mfCurrent =
    input.latest?.mf_value ??
    input.funds.reduce((sum, f) => sum + (f.current_value_inr ?? 0), 0);
  const mf = buildCompositionBucket({
    label: "Mutual Funds",
    currentInr: mfCurrent,
    contributionsInr: mfInvested,
    estimated: false,
  });

  // ── NPS bucket ──
  // total_invested_inr is the source of truth for lifetime NPS
  // contributions. Current value comes from nw_daily.nps_value which
  // is computed daily from units × NAV — same numbers as the headline.
  const npsInvested = input.nps?.total_invested_inr ?? 0;
  const npsCurrent = input.latest?.nps_value ?? 0;
  const nps = buildCompositionBucket({
    label: "NPS",
    currentInr: npsCurrent,
    contributionsInr: npsInvested,
    estimated: false,
  });

  // ── EPF bucket ──
  // lifetime_contribution_inr and lifetime_interest_inr live on
  // epf_state (2026-07-17-epf-lifetime-split.sql). balance_inr is the
  // hero number. The `estimated` flag is set to true because the
  // seed assumes pre-FY25 opening balance = 100% contributions —
  // slightly overstates contributions. Will drop to false once user
  // uploads older passbooks and we rebalance.
  //
  // A missing epf_state row (fresh install) shows a zero-slice donut
  // rather than crashing; the UI handles the "0 total" case as
  // "no data yet".
  const epfContrib = input.epf?.lifetime_contribution_inr ?? 0;
  const epfCurrent = input.epf?.balance_inr ?? 0;
  const epf = buildCompositionBucket({
    label: "EPF",
    currentInr: epfCurrent,
    contributionsInr: epfContrib,
    estimated: (epfContrib ?? 0) > 0, // any seed = estimated for now
  });

  // ── NW rollup ──
  // Sum the three buckets. Only the EPF slice is estimated, so the NW
  // rollup inherits `estimated: true` — the UI shows the "?" annotation
  // on the NW pie to hint that its underlying data has a rough edge.
  const nwContrib = mf.contributionsInr + nps.contributionsInr + epf.contributionsInr;
  const nwCurrent = mf.currentInr + nps.currentInr + epf.currentInr;
  const nwBucket = buildCompositionBucket({
    label: "Total Net Worth",
    currentInr: nwCurrent,
    contributionsInr: nwContrib,
    estimated: epf.estimated,
  });

  return { nw: nwBucket, mf, nps, epf };
}

// ─── Overview page ─────────────────────────────────────────────────────────

export async function getOverviewData(): Promise<OverviewData> {
  // fundsRes used to be a count-only head query; we now fetch three columns
  // so the same round-trip covers count + asset-allocation computation. If
  // the tuple grows further we can split it back into two queries, but at
  // 10-20 funds per user this stays cheaper as a single .select.
  const [
    nwRes,
    npsRes,
    epfRes,
    fundsRes,
    lastSyncRes,
    creditsRes,
    mfLedger,
    reconstructedRes,
    npsTxRows,
    npsNavRows,
    config,
    indexLevels,
  ] = await Promise.all([
    // Paginated: nw_daily grows 1 row/day and drives every trend chart.
    // Currently ~13 rows (fresh install) but a plain .select() would
    // silently truncate at 1000 within ~2.7 years and stop the Overview
    // chart from advancing. See the pagination-helper block comment.
    fetchAllPagesResult<NwRow>((from, to) =>
      sb
        .from("nw_daily")
        .select("*")
        .order("date", { ascending: true })
        .range(from, to)
    ),
    sb.from("nps_state").select("*").eq("id", 1).maybeSingle(),
    sb.from("epf_state").select("*").eq("id", 1).maybeSingle(),
    // invested_inr added so we can compute the MF composition bucket
    // (contributions vs growth). Same round-trip as before — one extra
    // column, no extra query.
    sb.from("fund_holdings").select("fund_code, cap_type, current_value_inr, invested_inr"),
    sb
      .from("fund_holdings")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from("retirement_credits").select("*").order("credit_date", { ascending: false }),
    // MF ledger union — powers `mf_deposits_ledger` enrichment below.
    // Missing tables degrade to empty (see fetchMfLedger); Overview
    // still renders using the legacy `mf_invested` snapshot as
    // fallback in that case.
    fetchMfLedger(),
    // Reconstructed pre-tracking MF snapshot rows (see
    // scripts/backfill-mf-reconstruction.mjs + the 2026-07-18 daily
    // reconstruction migration). Merged into `history` below so the
    // MF Growth chart can render the full Jan → today story.
    // Missing table degrades to empty — the chart falls back to its
    // pre-reconstruction behaviour (Jul 12 → today).
    //
    // Paginated for the same reason as nw_daily above — 1 row/day
    // growth, currently ~186 rows since Jan 2026, ~2.2 years to cap.
    fetchAllPagesResult<{
      date: string;
      mf_value_inr: number;
      mf_invested_inr: number;
      mf_equity_inr: number | null;
      mf_debt_inr: number | null;
      mf_1d_change_inr: number | null;
      mf_1d_change_pct: number | null;
      mf_gain_pct: number | null;
    }>((from, to) =>
      sb
        .from("mf_daily_reconstructed")
        .select(
          "date,mf_value_inr,mf_invested_inr,mf_equity_inr,mf_debt_inr,mf_1d_change_inr,mf_1d_change_pct,mf_gain_pct"
        )
        .order("date", { ascending: true })
        .range(from, to)
    ),
    // NPS reconstruction inputs — parallel fetch, degrade to empty on
    // missing tables (fetchNpsLedger / fetchNpsNavHistory handle their
    // own 42P01/PGRST205 detection). Together they feed
    // buildNpsDailyHistory below to produce the pre-tracking NPS
    // curve, mirroring what mf_daily_reconstructed does for MF.
    fetchNpsLedger(),
    fetchNpsNavHistory(),
    fetchConfigMap(),
    fetchIndexLevels(),
  ]);
  if (nwRes.error) throw nwRes.error;
  if (npsRes.error) throw npsRes.error;
  if (epfRes.error) throw epfRes.error;
  if (fundsRes.error) throw fundsRes.error;
  if (lastSyncRes.error) throw lastSyncRes.error;
  // Credits table may not exist yet if migration 2026-07-16-retirement-
  // credits-ledger.sql hasn't been applied. Fall back to empty array so
  // the Overview still renders — attribution will treat every NPS/EPF
  // change as growth, which is graceful degradation until the migration
  // is applied. Log the missing-table case so it doesn't fail silently.
  //
  // Two error codes indicate the same thing here:
  //   • 42P01   → PostgreSQL "relation does not exist" (direct DDL result)
  //   • PGRST205 → PostgREST "table not in schema cache" (what the client
  //                surfaces when the table was created outside PostgREST's
  //                cache-refresh cycle — i.e. exactly our case here)
  if (creditsRes.error) {
    const code = (creditsRes.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] retirement_credits table missing — apply migration " +
          "2026-07-16-retirement-credits-ledger.sql to enable ledger-based attribution."
      );
    } else {
      throw creditsRes.error;
    }
  }
  // Same graceful-degradation dance for the reconstruction table: missing
  // = pre-tracking chart segment simply doesn't render (chart falls back
  // to nw_daily-only, matching the pre-2026-07-18 behaviour).
  if (reconstructedRes.error) {
    const code = (reconstructedRes.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] mf_daily_reconstructed table missing — apply migration " +
          "2026-07-18-mf-daily-reconstruction.sql and run scripts/backfill-mf-reconstruction.mjs " +
          "to enable pre-tracking MF chart segment."
      );
    } else {
      throw reconstructedRes.error;
    }
  }

  const rawHistory = (nwRes.data ?? []) as NwRow[];

  // ── Enrich history with ledger-derived cumulative deposits ────────
  // For each nw_daily row we look up "how much net money had been
  // deposited into MFs as of THIS date" from the union'd ledger. Powers
  // the MF Attribution chart's Deposits curve — see `mf_deposits_ledger`
  // in NwRow for full rationale. If both ledger tables are empty (bootstrap
  // install), we skip enrichment and consumers fall back to `mf_invested`.
  let history: NwRow[] = rawHistory;
  const cumMap = mfLedger.length > 0 ? buildCumulativeDepositMap(mfLedger) : null;
  const sortedDepositDates = cumMap ? [...cumMap.keys()].sort() : [];
  if (cumMap) {
    history = rawHistory.map((r) => ({
      ...r,
      mf_deposits_ledger: cumulativeDepositsAsOf(
        cumMap,
        sortedDepositDates,
        r.date
      ),
    }));
  }

  // ── Build mfHistory: reconstructed + observed, prefer observed ────
  // Observed rows (nw_daily) always win over reconstructed rows for the
  // same date because they capture actual Dhan snapshots taken at the
  // real moment in time, whereas reconstructed rows are
  // CAS-transactions × mfapi-NAVs stitched together after the fact
  // (accurate but not observed).
  //
  // Currently the two ranges don't overlap — reconstruction stops the
  // day before nw_daily starts. But we still enforce "observed wins"
  // in case of future backfills, an nw_daily gap-fill, or a manual re-
  // reconstruction that ran further forward than intended.
  const reconstructedRaw = (reconstructedRes.data ?? []) as Array<{
    date: string;
    mf_value_inr: number;
    mf_invested_inr: number;
    mf_equity_inr: number | null;
    mf_debt_inr: number | null;
    mf_1d_change_inr: number | null;
    mf_1d_change_pct: number | null;
    mf_gain_pct: number | null;
  }>;
  const observedDates = new Set(history.map((r) => r.date));
  const reconstructedRows: MfDailyRow[] = reconstructedRaw
    .filter((r) => !observedDates.has(r.date))
    .map((r) => {
      const row: MfDailyRow = {
        date: r.date,
        mf_value: Number(r.mf_value_inr),
        mf_invested: Number(r.mf_invested_inr),
        mf_equity_inr:
          r.mf_equity_inr === null ? null : Number(r.mf_equity_inr),
        mf_debt_inr: r.mf_debt_inr === null ? null : Number(r.mf_debt_inr),
        mf_gain_pct:
          r.mf_gain_pct === null ? null : Number(r.mf_gain_pct),
        mf_1d_change_inr:
          r.mf_1d_change_inr === null ? null : Number(r.mf_1d_change_inr),
        mf_1d_change_pct:
          r.mf_1d_change_pct === null ? null : Number(r.mf_1d_change_pct),
        is_reconstructed: true,
      };
      if (cumMap) {
        row.mf_deposits_ledger = cumulativeDepositsAsOf(
          cumMap,
          sortedDepositDates,
          r.date
        );
      }
      return row;
    });
  const observedMfRows: MfDailyRow[] = history.map((r) => ({
    date: r.date,
    mf_value: r.mf_value,
    mf_invested: r.mf_invested,
    mf_equity_inr: r.mf_equity_inr,
    mf_debt_inr: r.mf_debt_inr,
    mf_gain_pct: r.mf_gain_pct,
    mf_1d_change_inr: r.mf_1d_change_inr,
    mf_1d_change_pct: r.mf_1d_change_pct,
    mf_deposits_ledger: r.mf_deposits_ledger,
    is_reconstructed: false,
  }));
  const mfHistory: MfDailyRow[] = [...reconstructedRows, ...observedMfRows].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  );

  // ── Build npsHistory: reconstructed daily curve × observed prefer ─
  // Same pattern as mfHistory. buildNpsDailyHistory returns the merged
  // series directly: reconstructed rows outside the nw_daily window,
  // observed rows for overlapping dates (Kotak close wins over
  // npsnav.in's next-day-published NAV).
  //
  // Empty when either input is missing:
  //   • no NAV history table → chart shows "Building history" state
  //   • no nps_transactions   → same (can't reconstruct invested curve)
  // In either case the app degrades gracefully; the chart card just
  // renders its empty state until the migrations are applied and the
  // backfill is run.
  const npsHistory: NpsDailyRow[] = buildNpsDailyHistory(
    npsTxRows,
    npsNavRows,
    history
  );

  const latest = history.length ? history[history.length - 1] : null;
  // XIRR needs the real, ledger-precise "today" value as its terminal
  // flow, not a possibly-anchored reconstructed one — nw_daily.nps_value
  // (Kotak's authoritative same-day close) is exactly what the rest of
  // the Overview page treats as ground truth for "current NPS value", so
  // reusing it here keeps this number consistent with everything else
  // shown alongside it rather than introducing a second, competing
  // "current value" definition.
  const npsXirr = computeNpsXirr(
    npsTxRows,
    latest?.date ?? null,
    latest?.nps_value ?? null
  );
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const nps = (npsRes.data as NpsState) ?? null;
  const funds = (fundsRes.data ?? []) as Array<{
    fund_code: string;
    cap_type: string | null;
    current_value_inr: number | null;
    invested_inr: number | null;
  }>;

  // Asset allocation (Equity vs Debt) — see AssetSplit type for bucket
  // definitions. Uses `cap_type` on fund_holdings as the sole classifier:
  // 'debt' → Debt bucket, anything else → Equity bucket. Rows with null
  // cap_type default to Equity (safer than dropping — a mis-tagged large-cap
  // fund shouldn't silently vanish from the split).
  const mfEquity = funds
    .filter((f) => (f.cap_type ?? "large") !== "debt")
    .reduce((sum, f) => sum + (f.current_value_inr ?? 0), 0);
  const mfDebt = funds
    .filter((f) => f.cap_type === "debt")
    .reduce((sum, f) => sum + (f.current_value_inr ?? 0), 0);

  const npsValue = latest?.nps_value ?? 0;
  const npsEquity = nps ? npsValue * ((nps.alloc_e_pct ?? 0) / 100) : 0;
  const npsDebt = nps
    ? npsValue * (((nps.alloc_c_pct ?? 0) + (nps.alloc_g_pct ?? 0)) / 100)
    : 0;
  const epfDebt = latest?.epf_estimate ?? 0;

  const totalEquity = mfEquity + npsEquity;
  const totalDebt = mfDebt + npsDebt + epfDebt;
  const totalConsidered = totalEquity + totalDebt;
  const assetSplit: AssetSplit | null =
    totalConsidered > 0
      ? {
          totalEquity,
          totalDebt,
          totalConsidered,
          equityPct: (totalEquity / totalConsidered) * 100,
          debtPct: (totalDebt / totalConsidered) * 100,
          breakdown: { mfEquity, mfDebt, npsEquity, npsDebt, epfDebt },
        }
      : null;

  const credits = ((creditsRes.data ?? []) as RetirementCredit[]);
  const epf = (epfRes.data as EpfState) ?? null;

  return {
    latest,
    prev,
    history,
    mfHistory,
    npsHistory,
    npsXirr,
    nps,
    epf,
    fundCount: funds.length,
    lastSync: (lastSyncRes.data as { updated_at: string } | null)?.updated_at ?? null,
    config,
    assetSplit,
    nwDeltas: computeNwDeltas(history),
    liquiditySplit: computeLiquiditySplit(latest),
    credits,
    wealthComposition: computeWealthComposition({ latest, nps, epf, funds }),
    indexLevels,
  };
}

// ─── Portfolio page ────────────────────────────────────────────────────────

export async function getPortfolioData(): Promise<PortfolioData> {
  // fund_holdings_detail (~930 rows) and master_security_classification
  // (~3,200 rows) both exceed or approach PostgREST's 1000-row cap on
  // this project — fetchAllPages() drives explicit pagination for
  // each. See the helper's comment at the top of this file.
  //
  // The master query needs 5 columns for the Portfolio look-through
  // (isin, mcap_classification, macro_economic_sector, region, source).
  // `source` is used downstream (in getSyncData → CapClassification)
  // to split Large into N50 / NN50 / Override sub-buckets for the
  // classification card. The look-through itself no longer weights
  // NN50 (both N50 and NN50 count as 100 % Large as of 2026-07-27).
  // MasterSecurity's static type doesn't expose `source` (it's an
  // optional column added post-hoc for cap classification), hence the
  // intersection.
  type PortfolioMasterRow = Pick<
    MasterSecurity,
    "isin" | "mcap_classification" | "macro_economic_sector" | "region"
  > & { source: string | null };
  const [funds, detailRows, latestNw, masterRows] = await Promise.all([
    sb.from("fund_holdings").select("*").order("current_value_inr", { ascending: false }),
    fetchAllPages<FundHoldingDetail>((from, to) =>
      sb
        .from("fund_holdings_detail")
        .select("fund_code,isin,company_name,weighting_pct")
        .range(from, to)
    ),
    sb
      .from("nw_daily")
      .select("mf_value,nps_value,epf_estimate,total_nw")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetchAllPages<PortfolioMasterRow>((from, to) =>
      sb
        .from("master_security_classification")
        .select("isin,mcap_classification,macro_economic_sector,region,source")
        .range(from, to)
    ),
  ]);
  if (funds.error) throw funds.error;
  if (latestNw.error) throw latestNw.error;

  const fundRows = (funds.data ?? []) as Fund[];

  // Top 5 per fund
  const topByFund: Record<string, FundHoldingDetail[]> = {};
  for (const h of detailRows) {
    if (!topByFund[h.fund_code]) topByFund[h.fund_code] = [];
    topByFund[h.fund_code].push(h);
  }
  for (const code of Object.keys(topByFund)) {
    topByFund[code] = topByFund[code]
      .sort((a, b) => b.weighting_pct - a.weighting_pct)
      .slice(0, 5);
  }

  // Asset allocation (MF / NPS / EPF)
  const nw = (latestNw.data as { mf_value: number; nps_value: number; epf_estimate: number; total_nw: number } | null);
  const totalNw = nw?.total_nw ?? 0;
  const mfTotal = nw?.mf_value ?? fundRows.reduce((s, f) => s + f.current_value_inr, 0);

  const assetAllocation: AllocationSlice[] = nw
    ? [
        { name: "Mutual Funds", value: nw.mf_value, key: "mf" },
        { name: "EPF", value: nw.epf_estimate, key: "epf" },
        { name: "NPS", value: nw.nps_value, key: "nps" },
      ]
    : [];

  // Sector exposure — join detail × master by ISIN in memory
  const masterByIsin = new Map(masterRows.map((m) => [m.isin, m]));
  const fundValueByCode = new Map(fundRows.map((f) => [f.fund_code, f.current_value_inr]));

  // ── Look-through cap allocation ─────────────────────────────────────
  // Replaces the old "group funds by cap_type" logic which was wrong
  // because it classified an entire flexi/large-cap fund as one bucket
  // even when a chunk of the fund sat in mid/small stocks.
  //
  // New rules, applied per stock via fund_holdings_detail × master:
  //   • master.mcap_classification = Large → 100% Large
  //       (covers both nse-nifty50 and nse-niftynext50 sources — see
  //       NN50 convention note on the interface above)
  //   • master.mcap_classification = Mid   → 100% Mid
  //   • Small / Micro / Nano               → 100% Small
  //   • master.region = US (or mcap = US)  → 100% International
  //   • unmapped / unclassified stock      → falls back to fund.cap_type
  //   • fund-level residual (V − Σposition, i.e. cash / unlisted /
  //     non-security holdings we don't have detail rows for) → fund.cap_type
  //
  // Debt / Intl funds skip look-through entirely and dump their full
  // value into their bucket; individual debt bonds aren't in
  // master_security_classification and their fund cap_type is more
  // reliable than any per-row classification could be.
  //
  // Two derived views are exposed:
  //   • indianEquityCapSplit — Large/Mid/Small only, sums to
  //     `indianEquityTotal` (100% within Indian equity)
  //   • mfComposition — Indian equity vs Debt vs International, sums
  //     to `mfTotal`

  // Pre-index detail rows by fund_code so we don't re-scan the whole
  // detailRows array per fund below (fundRows can be ~20+, detailRows
  // can be ~900+; O(F·D) → O(F+D)).
  const detailsByFund = new Map<string, FundHoldingDetail[]>();
  for (const h of detailRows) {
    const arr = detailsByFund.get(h.fund_code);
    if (arr) arr.push(h);
    else detailsByFund.set(h.fund_code, [h]);
  }

  let largeInr = 0;
  let midInr = 0;
  let smallInr = 0;
  let intlInr = 0;
  let debtInr = 0;

  const addToFundCap = (capType: CapType, amount: number) => {
    if (amount <= 0) return;
    switch (capType) {
      case "large":
        largeInr += amount;
        break;
      case "mid":
        midInr += amount;
        break;
      case "small":
        smallInr += amount;
        break;
      case "intl":
        intlInr += amount;
        break;
      case "debt":
        debtInr += amount;
        break;
    }
  };

  for (const f of fundRows) {
    const V = f.current_value_inr;
    if (V <= 0) continue;

    // Debt / Intl funds bypass look-through: their per-holding
    // classification (bond ISINs mostly aren't in master, US ETFs
    // wrap thousands of underlyings) is unreliable, so trust the
    // fund-level label.
    if (f.cap_type === "debt") {
      debtInr += V;
      continue;
    }
    if (f.cap_type === "intl") {
      intlInr += V;
      continue;
    }

    // Equity fund: look through to stocks
    const details = detailsByFund.get(f.fund_code) ?? [];
    let classifiedValue = 0;
    for (const h of details) {
      const position = (V * h.weighting_pct) / 100;
      if (position <= 0) continue;
      classifiedValue += position;

      const m = masterByIsin.get(h.isin);
      if (!m) {
        addToFundCap(f.cap_type, position);
        continue;
      }

      // Region trumps mcap: a US stock inside a domestic flexi-cap
      // fund is International exposure, not Large.
      if (m.region === "US" || m.region === "International") {
        intlInr += position;
        continue;
      }

      const mcap = m.mcap_classification;
      if (mcap === "Large") {
        // Both N50 and NN50 rows carry mcap_classification="Large" —
        // treated identically here. NN50 no longer contributes a mid
        // slice (2026-07-27 convention change; see interface docstring).
        largeInr += position;
      } else if (mcap === "Mid") {
        midInr += position;
      } else if (mcap === "Small" || mcap === "Micro" || mcap === "Nano") {
        smallInr += position;
      } else if (mcap === "US") {
        intlInr += position;
      } else {
        // Unclassified stock in an equity fund — best-effort fallback
        // to the fund's SEBI label. Rare in practice once the cap
        // classification refresh has run.
        addToFundCap(f.cap_type, position);
      }
    }

    // Residual: value not covered by fund_holdings_detail. Typically
    // cash, small unlisted names, or funds we don't have a detail
    // fetch for yet. Bucket under the fund's cap_type so it doesn't
    // vanish from the ratios.
    const residual = V - classifiedValue;
    if (residual > 0.01) {
      addToFundCap(f.cap_type, residual);
    }
  }

  const indianEquityTotal = largeInr + midInr + smallInr;
  const indianEquityCapSplit: AllocationSlice[] = [
    { name: "Large cap", value: largeInr, key: "large" },
    { name: "Mid cap", value: midInr, key: "mid" },
    { name: "Small cap", value: smallInr, key: "small" },
  ].filter((s) => s.value > 0);
  const mfComposition: AllocationSlice[] = [
    { name: "Indian equity", value: indianEquityTotal, key: "indian_equity" },
    { name: "Debt", value: debtInr, key: "debt" },
    { name: "International", value: intlInr, key: "intl" },
  ].filter((s) => s.value > 0);

  const sectorAgg = new Map<string, { value: number; companies: Set<string> }>();
  let grand = 0;
  for (const h of detailRows) {
    const fundValue = fundValueByCode.get(h.fund_code) ?? 0;
    const positionInr = (fundValue * h.weighting_pct) / 100;
    const master = masterByIsin.get(h.isin);
    const sector = master?.macro_economic_sector;
    if (!sector) continue;
    if (!sectorAgg.has(sector))
      sectorAgg.set(sector, { value: 0, companies: new Set() });
    const bucket = sectorAgg.get(sector)!;
    bucket.value += positionInr;
    bucket.companies.add(h.isin);
    grand += positionInr;
  }
  const sectorList = Array.from(sectorAgg.entries())
    .map(([name, s]) => ({
      name,
      pct: grand > 0 ? (s.value / grand) * 100 : 0,
      companies: s.companies.size,
    }))
    .sort((a, b) => b.pct - a.pct);

  const sectorExposure: SectorSlice[] = sectorList.map((s, i) => ({
    ...s,
    tier: i < 3 ? "primary" : "secondary",
  }));

  // ── Sector concentration (top 3 with severity) ──
  // See SectorConcentration type comment for threshold rationale. Top 3
  // is fixed — the SectorExposure card below covers the rest.
  const sectorConcentration: SectorConcentration[] = sectorList
    .slice(0, 3)
    .map((s) => ({
      name: s.name,
      pct: s.pct,
      companies: s.companies,
      severity: severityFor(s.pct),
    }));

  // ── Aggregated look-through: one row per ISIN, summing effective ₹ ──
  // Two derived views (topStocks + crossFundOverlap) both read from this
  // single aggregation, so we compute it ONCE.
  //
  // Formula per detail row: positionInr = fund_value × weighting_pct/100
  // Sum across all funds that hold the ISIN → effective_inr per stock.
  // fund_codes list is kept in insertion order (which follows the outer
  // funds-sorted-by-value ordering), so the leading fund in the list is
  // the one contributing the largest position for that stock — a small
  // UX bonus for the "Held in …" column tooltip.
  type StockAggBucket = {
    isin: string;
    company_name: string;
    effective_inr: number;
    fund_codes: string[];
    cap_type: string | null;
    sector: string | null;
  };
  const stockAgg = new Map<string, StockAggBucket>();
  for (const h of detailRows) {
    const fundValue = fundValueByCode.get(h.fund_code) ?? 0;
    if (fundValue <= 0) continue;
    const positionInr = (fundValue * h.weighting_pct) / 100;
    if (positionInr <= 0) continue;
    const master = masterByIsin.get(h.isin);
    const bucket = stockAgg.get(h.isin);
    if (bucket) {
      bucket.effective_inr += positionInr;
      // Guard against a fund appearing twice (shouldn't happen given
      // fund_holdings_detail's (fund_code, isin) unique-ish shape, but
      // defended for safety when re-syncs land duplicates).
      if (!bucket.fund_codes.includes(h.fund_code)) {
        bucket.fund_codes.push(h.fund_code);
      }
    } else {
      stockAgg.set(h.isin, {
        isin: h.isin,
        company_name: h.company_name,
        effective_inr: positionInr,
        fund_codes: [h.fund_code],
        cap_type: master?.mcap_classification ?? null,
        sector: master?.macro_economic_sector ?? null,
      });
    }
  }
  const lookthrough: LookthroughStock[] = Array.from(stockAgg.values()).map(
    (b) => ({
      isin: b.isin,
      company_name: b.company_name,
      effective_inr: b.effective_inr,
      pct_of_mf: mfTotal > 0 ? (b.effective_inr / mfTotal) * 100 : 0,
      n_funds: b.fund_codes.length,
      fund_codes: b.fund_codes,
      cap_type: b.cap_type,
      sector: b.sector,
    })
  );

  // Top 10 by effective_inr — the "your actual biggest positions" list
  // that's invisible when you only look per-fund.
  const topStocks = [...lookthrough]
    .sort((a, b) => b.effective_inr - a.effective_inr)
    .slice(0, 10);

  // Cross-fund overlap: 2+ funds. Client filters up to 3+/4+/5+.
  // Sort by n_funds first (that's the concentration signal — a 5-fund
  // stock is more important to surface than a 2-fund stock even if it's
  // smaller in ₹), then by effective_inr as a tiebreak.
  const crossFundOverlap = lookthrough
    .filter((s) => s.n_funds >= 2)
    .sort((a, b) => {
      if (b.n_funds !== a.n_funds) return b.n_funds - a.n_funds;
      return b.effective_inr - a.effective_inr;
    });

  // Group by sector for the click-to-drill modal. Same-sector stocks
  // are already scattered across `lookthrough`; bucketing them once
  // server-side avoids repeated filtering on the client when the user
  // clicks around between sectors. Stocks without a classified sector
  // (master.macro_economic_sector is null) are excluded — they show
  // up in the "Uncategorized" bucket on other views but the modal is
  // sector-drill so they'd be noise here.
  const stocksBySector: Record<string, LookthroughStock[]> = {};
  for (const stock of lookthrough) {
    if (!stock.sector) continue;
    if (!stocksBySector[stock.sector]) stocksBySector[stock.sector] = [];
    stocksBySector[stock.sector].push(stock);
  }
  for (const key of Object.keys(stocksBySector)) {
    stocksBySector[key].sort((a, b) => b.effective_inr - a.effective_inr);
  }

  // ── Headline: invested / current / gain / 1D ──
  // 1D aggregate: sum of one_day_change_inr across funds (Groww's per-
  // fund chip). Null when no fund has a persisted value yet.
  const invested = fundRows.reduce((s, f) => s + (f.invested_inr ?? 0), 0);
  const oneDayFunds = fundRows.filter((f) => f.one_day_change_inr != null);
  const oneDayInr = oneDayFunds.length
    ? oneDayFunds.reduce((s, f) => s + (f.one_day_change_inr ?? 0), 0)
    : null;
  const oneDayPct =
    oneDayInr != null && mfTotal - oneDayInr > 0
      ? (oneDayInr / (mfTotal - oneDayInr)) * 100
      : null;
  const gainInr = mfTotal - invested;
  const gainPct = invested > 0 ? (gainInr / invested) * 100 : 0;
  const headline: PortfolioHeadline = {
    invested,
    current: mfTotal,
    gainInr,
    gainPct,
    oneDayInr,
    oneDayPct,
    fundCount: fundRows.length,
  };

  return {
    funds: fundRows,
    topHoldingsByFund: topByFund,
    assetAllocation,
    mfComposition,
    indianEquityCapSplit,
    indianEquityTotal,
    sectorExposure,
    totalNw,
    mfTotal,
    headline,
    topStocks,
    crossFundOverlap,
    sectorConcentration,
    stocksBySector,
  };
}

/**
 * Map a sector's % share to a severity bucket for the concentration
 * warning strip. Thresholds baked in per HANDOVER §15.2 spec.
 */
function severityFor(pct: number): SectorSeverity {
  if (pct > 30) return "alert";
  if (pct > 25) return "warning";
  if (pct > 20) return "info";
  return "safe";
}

// ─── Sync page ─────────────────────────────────────────────────────────────

export async function getSyncData(): Promise<SyncData> {
  // fund_holdings_detail and master_security_classification each need
  // fetchAllPages() to bypass the db-max-rows=1000 cap — see helper
  // comment at the top of this file. The other queries stay in the
  // Supabase envelope shape (`{ data, error }`) because they're
  // small/bounded (nps_state, portfolio_config, single-row lookups).
  type FundRow = {
    fund_code: string;
    fund_name: string;
    cap_type: CapType;
    updated_at: string;
    current_value_inr: number;
    nav: number | null;
    nav_prev: number | null;
    nav_date: string | null;
    nav_updated_at: string | null;
    nav_source: MfNavSource | null;
  };
  type DetailRow = {
    fund_code: string;
    weighting_pct: number;
    isin: string;
    extracted_at: string | null;
    portfolio_date: string | null;
  };
  // Wider than a plain `mcap_classification` column now — we need
  // enough fields per row to render the drill-down modal without a
  // second round-trip. Kept as `select("*")` -ish but explicitly
  // listed so tsc catches any master-schema drift.
  //
  // `confidence` is only used to tally the manual-override count in
  // the sync card footer — it's cheap to piggy-back on this query.
  type CapDistRow = {
    isin: string;
    symbol: string | null;
    company_name: string;
    mcap_classification: string | null;
    raw_sector: string | null;
    index_membership: string | null;
    source: string | null;
    confidence: string | null;
  };

  const [
    funds,
    details,
    nonSecAgg,
    lastSyncRes,
    diagAgg,
    npsRes,
    epfRes,
    capDistRows,
    capSyncTsRes,
    indexLevels,
  ] = await Promise.all([
    // Select is broader here than in fundResync-only paths because this
    // same query also feeds the mf summary block below (nav, nav_prev,
    // nav_date, nav_updated_at, nav_source). One round-trip instead of
    // two.
    sb
      .from("fund_holdings")
      .select(
        "fund_code,fund_name,cap_type,updated_at,current_value_inr,nav,nav_prev,nav_date,nav_updated_at,nav_source"
      )
      .order("current_value_inr", { ascending: false }),
    fetchAllPages<DetailRow>((from, to) =>
      sb
        .from("fund_holdings_detail")
        .select("fund_code,weighting_pct,isin,extracted_at,portfolio_date")
        .range(from, to)
    ),
    sb.from("fund_non_security_holdings").select("fund_code,weighting_pct,extracted_at,portfolio_date"),
    sb
      .from("fund_holdings")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Diagnostics are optional — if the migration hasn't been run yet in a
    // given environment, we still want the Sync page to work. Errors here
    // are logged and treated as "no diagnostics available".
    sb.from("fund_sync_diagnostics").select("fund_code,unresolved,unknown_holding_types"),
    // NPS state powers the "Refresh NPS NAVs" card AND the amount-input
    // hint/split-message on LogCreditEventCard. Two consumers, one row —
    // so select *. Full-row read of a single-row table is trivially
    // cheap and keeps the code simple (one shape, no field-picking gymnastics).
    // Graceful-degradation: if the migration for nav_date / nav_updated_at
    // hasn't run, we return null and both cards still render (nav card
    // without "Last refreshed", log card falls back to "0" placeholder).
    sb.from("nps_state").select("*").eq("id", 1).maybeSingle(),
    // EPF state — new consumer as of the credit-log consolidation
    // (LogCreditEventCard uses monthly_contribution_inr as the amount hint
    // for EPF+payroll). Same graceful-null pattern as nps.
    sb.from("epf_state").select("*").eq("id", 1).maybeSingle(),
    // Cap-classification distribution + per-row detail — feeds the
    // tile counts AND the drill-down modal on the Refresh Cap
    // Classifications card. Paginated because India-equity rows alone
    // hit ~2,400 (post-EQUITY_L backfill) which is well past the 1000-
    // row PostgREST cap. Both regions come back in one paginated call
    // (region IN (...)) rather than two — halves the round-trip count
    // and lets us group on the client with one loop.
    fetchAllPages<CapDistRow & { region: string | null }>((from, to) =>
      sb
        .from("master_security_classification")
        .select(
          "isin,symbol,company_name,mcap_classification,raw_sector,index_membership,source,confidence,region"
        )
        .in("region", ["India", "US"])
        .eq("security_type", "Equity")
        .eq("holding_level", "Individual")
        .range(from, to)
    ),
    // Last cap-classification sync timestamp lives in portfolio_config
    // (KV table). Optional — a fresh install won't have this row yet.
    sb
      .from("portfolio_config")
      .select("value")
      .eq("key", "cap_classification_last_synced_at")
      .maybeSingle(),
    fetchIndexLevels(),
  ]);
  if (funds.error) throw funds.error;
  if (nonSecAgg.error) throw nonSecAgg.error;
  if (lastSyncRes.error) throw lastSyncRes.error;
  // diagAgg.error is intentionally not thrown — see comment above
  if (diagAgg.error) {
    console.warn("[getSyncData] fund_sync_diagnostics unavailable:", diagAgg.error.message);
  }

  const fundRows = (funds.data ?? []) as FundRow[];
  const nonSec = (nonSecAgg.data ?? []) as {
    fund_code: string; weighting_pct: number; extracted_at: string | null; portfolio_date: string | null;
  }[];
  type DiagRow = {
    fund_code: string;
    unresolved: { weighting_pct?: number }[] | null;
    unknown_holding_types: unknown[] | null;
  };
  const diagRows = (diagAgg.data ?? []) as DiagRow[];
  const diagByFund = new Map(diagRows.map((d) => [d.fund_code, d]));

  // Aggregate per-fund state from both look-through tables. Splitting the
  // coverage into security vs non-security lets the UI show a breakdown
  // tooltip (89.9% equity + 10.4% cash = 100.3%) so the user can tell where
  // a >100% total is coming from — usually rounding + hedge weights, not a
  // bug.
  const secWeightByFund: Record<string, number> = {};
  const secCountByFund: Record<string, number> = {};
  const nonSecWeightByFund: Record<string, number> = {};
  const nonSecCountByFund: Record<string, number> = {};
  const lastResyncByFund: Record<string, string> = {};
  const portfolioDateByFund: Record<string, string> = {};
  const bump = (rec: Record<string, string>, fc: string, ts: string | null) => {
    if (!ts) return;
    if (!rec[fc] || ts > rec[fc]) rec[fc] = ts;
  };
  for (const d of details) {
    secWeightByFund[d.fund_code] = (secWeightByFund[d.fund_code] ?? 0) + d.weighting_pct;
    secCountByFund[d.fund_code] = (secCountByFund[d.fund_code] ?? 0) + 1;
    bump(lastResyncByFund, d.fund_code, d.extracted_at);
    bump(portfolioDateByFund, d.fund_code, d.portfolio_date);
  }
  for (const n of nonSec) {
    nonSecWeightByFund[n.fund_code] = (nonSecWeightByFund[n.fund_code] ?? 0) + n.weighting_pct;
    nonSecCountByFund[n.fund_code] = (nonSecCountByFund[n.fund_code] ?? 0) + 1;
    bump(lastResyncByFund, n.fund_code, n.extracted_at);
    bump(portfolioDateByFund, n.fund_code, n.portfolio_date);
  }

  const fundResync: FundResyncStatus[] = fundRows.map((f) => {
    const sec = secWeightByFund[f.fund_code] ?? 0;
    const nsec = nonSecWeightByFund[f.fund_code] ?? 0;
    const coverage = sec + nsec;
    // Fall back to fund_holdings.updated_at only if this fund has never had
    // a Dhan resync (fresh install) — otherwise always use the actual
    // Dhan extracted_at so the timestamp reflects what the button did.
    const lastResyncAt = lastResyncByFund[f.fund_code] ?? f.updated_at;
    const diag = diagByFund.get(f.fund_code);
    const unresolvedList = diag?.unresolved ?? [];
    const unresolvedWeight = unresolvedList.reduce(
      (s, u) => s + (Number(u.weighting_pct) || 0),
      0
    );
    return {
      fund_code: f.fund_code,
      fund_name: f.fund_name,
      cap_type: f.cap_type,
      current_value_inr: f.current_value_inr,
      updated_at: lastResyncAt,
      coverage_pct: coverage,
      security_coverage_pct: sec,
      nonsec_coverage_pct: nsec,
      // Healthy >= 95%. Below that the fund has stale/missing look-through
      // data (typically debt bonds not seeded in master_security_classification)
      // and the "Low coverage" badge signals it needs manual review, not that the
      // resync failed.
      state: coverage < 95 ? "error" : "idle",
      detail_rows: secCountByFund[f.fund_code] ?? 0,
      nonsec_rows: nonSecCountByFund[f.fund_code] ?? 0,
      portfolio_date: portfolioDateByFund[f.fund_code] ?? null,
      unresolved_count: unresolvedList.length,
      unresolved_weight_pct: Number(unresolvedWeight.toFixed(2)),
      unknown_types_count: (diag?.unknown_holding_types ?? []).length,
    };
  });

  const npsRow = npsRes.data as {
    scheme_e_nav: number | null;
    scheme_c_nav: number | null;
    scheme_g_nav: number | null;
    scheme_e_units: number | null;
    scheme_c_units: number | null;
    scheme_g_units: number | null;
    scheme_e_nav_prev: number | null;
    scheme_c_nav_prev: number | null;
    scheme_g_nav_prev: number | null;
    nav_date: string | null;
    nav_updated_at: string | null;
    nav_source: NavSource | null;
  } | null;

  // ─── MF NAV summary for the unified RefreshNavsCard ──────────────
  //
  // Pick a headline nav_date = most common nav_date across funds. Same
  // reasoning as the refresh-mf-nav route: a lone T+2 FoF shouldn't
  // set the batch's label. If everything is null (fresh install,
  // pre-first-paste), headline stays null and the card renders a
  // "never refreshed" state.
  const dateFreq = new Map<string, number>();
  for (const f of fundRows) {
    if (f.nav_date) dateFreq.set(f.nav_date, (dateFreq.get(f.nav_date) ?? 0) + 1);
  }
  let mfHeadlineDate: string | null = null;
  let mfBestCount = 0;
  for (const [d, count] of dateFreq.entries()) {
    // Tiebreak: prefer the more recent date so a 5-5 split shows the fresh one.
    if (
      count > mfBestCount ||
      (count === mfBestCount && (mfHeadlineDate === null || d > mfHeadlineDate))
    ) {
      mfHeadlineDate = d;
      mfBestCount = count;
    }
  }
  const mfStaleCount = mfHeadlineDate
    ? fundRows.filter(
        (f) => f.nav_date != null && f.nav_date < mfHeadlineDate!
      ).length
    : 0;
  // Pick nav_source based on most-recent nav_updated_at across all
  // funds. If a Groww paste just landed and mfapi hasn't yet caught up,
  // the badge says "Groww" — accurate provenance.
  let mfLatestSource: MfNavSource | null = null;
  let mfLatestSourceTs = "";
  for (const f of fundRows) {
    if (f.nav_updated_at && f.nav_source) {
      if (f.nav_updated_at > mfLatestSourceTs) {
        mfLatestSourceTs = f.nav_updated_at;
        mfLatestSource = f.nav_source;
      }
    }
  }
  // Overall nav_updated_at for the card = max across all funds. The
  // mini-panel's "Last refreshed" ticker reads this.
  let mfLatestUpdatedAt: string | null = null;
  for (const f of fundRows) {
    if (
      f.nav_updated_at &&
      (mfLatestUpdatedAt === null || f.nav_updated_at > mfLatestUpdatedAt)
    ) {
      mfLatestUpdatedAt = f.nav_updated_at;
    }
  }
  const mfTotalValue = fundRows.reduce(
    (s, f) => s + Number(f.current_value_inr ?? 0),
    0
  );
  const mfHasPrev = fundRows.some((f) => Number(f.nav_prev ?? 0) > 0);

  // ─── Cap-classification distribution ───────────────────────────────
  //
  // Buckets pre-seeded to 0 so the tile grid always renders all 6 (a
  // fresh install without Nano still shows "Nano · 0" rather than
  // gapping the grid). Unclassified counts anything null/empty on
  // *India* rows only — those survive the sync untouched (either not
  // on NSE, or the pre-classifier hasn't run yet). US rows with
  // empty mcap don't count as unclassified — they're just US stocks
  // outside the SP500/Nasdaq 100 target set (INSM, ZS) and still
  // belong in the US bucket.
  const capCounts = {
    Large: 0,
    LargeN50: 0,
    LargeNN50: 0,
    LargeOverride: 0,
    Mid: 0,
    Small: 0,
    Micro: 0,
    Nano: 0,
    US: 0,
    unclassified: 0,
  };
  const capStocks: {
    LargeN50: CapStock[];
    LargeNN50: CapStock[];
    LargeOverride: CapStock[];
    Mid: CapStock[];
    Small: CapStock[];
    Micro: CapStock[];
    Nano: CapStock[];
    US: CapStock[];
  } = {
    LargeN50: [],
    LargeNN50: [],
    LargeOverride: [],
    Mid: [],
    Small: [],
    Micro: [],
    Nano: [],
    US: [],
  };

  const toCapStock = (r: CapDistRow): CapStock => ({
    isin: r.isin,
    symbol: r.symbol,
    company_name: r.company_name,
    raw_sector: r.raw_sector,
    index_membership: r.index_membership,
    source: r.source,
  });

  // Split a Large row into N50 vs NN50 based on the `source` string.
  // Handles both the canonical `nse-nifty50` / `nse-niftynext50`
  // values written by the current refresh route AND the legacy
  // uppercase `NIFTY 50` / `NIFTY NEXT 50` values that predated the
  // canonicalisation (a batch of ~50 rows still carry these until
  // the next Refresh sweep normalises them).
  //
  // Rows whose Large classification exists but source is anything
  // else (empty, "manual", "nse-nifty100" legacy, etc.) return null
  // here and land in the LargeOverride bucket in the loop below.
  // Nifty 50 and Nifty Next 50 are index-defined sets with exactly
  // 50 members each, so pretending an override belongs to either
  // would silently break that invariant and inflate the sub-bucket
  // counts against NSE's exact definitions.
  const largeSubFromSource = (
    src: string | null | undefined
  ): "N50" | "NN50" | null => {
    if (!src) return null;
    const s = src.trim().toLowerCase();
    if (s === "nse-nifty50" || s === "nifty 50") return "N50";
    if (s === "nse-niftynext50" || s === "nifty next 50") return "NN50";
    return null;
  };

  // Manual-override tally — rows whose `confidence` marks them as
  // sticky (never touched by the NSE refresh). Matches the
  // isManualOverride check in the refresh route so the two counts
  // stay in lock-step. Surfaced on the Sync page as a subtle
  // "N rows shielded" indicator, orthogonal to the bucket tiles.
  let manualOverrideCount = 0;

  for (const r of capDistRows) {
    if (r.confidence && r.confidence.toLowerCase().includes("manual")) {
      manualOverrideCount++;
    }
    const v = (r.mcap_classification ?? "").trim();
    // US rows land in the US bucket regardless of what mcap says — a
    // handful (INSM, ZS) have mcap="US" AND index_membership="" and
    // still belong here (they're US stocks not in our two target
    // indices). India rows use the classic 5-way tally, with Large
    // split via `source`.
    if (r.region === "US") {
      capCounts.US++;
      capStocks.US.push(toCapStock(r));
      continue;
    }
    if (v === "Large") {
      capCounts.Large++;
      // Sub-bucket is decided purely by the `source` string. This
      // trusts the operator's assertion for manual overrides:
      // when set-cap-override.mjs writes `source=nse-niftynext50`,
      // the row is claiming to be Nifty Next 50 tier regardless of
      // whether the current NSE NN50 CSV happens to contain the
      // ISIN yet (fresh demerger children, spin-offs, and stocks
      // ranked 51-100 by market cap but not admitted until the
      // next Sep/Mar rebalance all fall into this pattern).
      //
      // Rows whose Large classification exists but source is neither
      // canonical NSE tag (`manual`, empty, `nse-nifty100` legacy,
      // etc.) land in LargeOverride so the tile still shows them.
      const sub = largeSubFromSource(r.source);
      if (sub === "N50") {
        capCounts.LargeN50++;
        capStocks.LargeN50.push(toCapStock(r));
      } else if (sub === "NN50") {
        capCounts.LargeNN50++;
        capStocks.LargeNN50.push(toCapStock(r));
      } else {
        // Manual override without an asserted sub-bucket, or a
        // legacy `nse-nifty100` row not yet cleaned up by refresh.
        // Either way it stays out of N50/NN50 while remaining
        // visible + clickable in its own tile.
        capCounts.LargeOverride++;
        capStocks.LargeOverride.push(toCapStock(r));
      }
    } else if (v === "Mid") {
      capCounts.Mid++;
      capStocks.Mid.push(toCapStock(r));
    } else if (v === "Small") {
      capCounts.Small++;
      capStocks.Small.push(toCapStock(r));
    } else if (v === "Micro") {
      capCounts.Micro++;
      capStocks.Micro.push(toCapStock(r));
    } else if (v === "Nano") {
      capCounts.Nano++;
      capStocks.Nano.push(toCapStock(r));
    } else {
      capCounts.unclassified++;
    }
  }

  // Sort each bucket alphabetically by symbol so the modal renders a
  // predictable A→Z view. Falls back to company_name when symbol is
  // missing (a small tail of India ETFs stored without a ticker).
  const cmpSymbol = (a: CapStock, b: CapStock) => {
    const as = (a.symbol ?? a.company_name).toUpperCase();
    const bs = (b.symbol ?? b.company_name).toUpperCase();
    return as < bs ? -1 : as > bs ? 1 : 0;
  };
  for (const k of Object.keys(capStocks) as (keyof typeof capStocks)[]) {
    capStocks[k].sort(cmpSymbol);
  }

  const capLastSyncedAt =
    (capSyncTsRes.data as { value: string | null } | null)?.value ?? null;

  return {
    lastSync: (lastSyncRes.data as { updated_at: string } | null)?.updated_at ?? null,
    fundCount: fundRows.length,
    totalDetailRows: details.length + nonSec.length,
    fundResync,
    mf: fundRows.length
      ? {
          nav_date: mfHeadlineDate,
          nav_updated_at: mfLatestUpdatedAt,
          nav_source: mfLatestSource,
          total_value_inr: mfTotalValue,
          fund_count: fundRows.length,
          stale_fund_count: mfStaleCount,
          has_prev: mfHasPrev,
        }
      : null,
    nps: npsRow
      ? {
          nav_date: npsRow.nav_date,
          nav_updated_at: npsRow.nav_updated_at,
          nav_source: npsRow.nav_source,
          nps_value_inr:
            Number(npsRow.scheme_e_units ?? 0) * Number(npsRow.scheme_e_nav ?? 0) +
            Number(npsRow.scheme_c_units ?? 0) * Number(npsRow.scheme_c_nav ?? 0) +
            Number(npsRow.scheme_g_units ?? 0) * Number(npsRow.scheme_g_nav ?? 0),
          scheme_e_nav: npsRow.scheme_e_nav,
          scheme_c_nav: npsRow.scheme_c_nav,
          scheme_g_nav: npsRow.scheme_g_nav,
          // has_prev flags whether the second-refresh has happened yet;
          // the card uses this to show "1D delta available after next refresh"
          // on first-ever use, rather than a misleading 0.00 delta.
          has_prev:
            (npsRow.scheme_e_nav_prev ?? 0) > 0 ||
            (npsRow.scheme_c_nav_prev ?? 0) > 0 ||
            (npsRow.scheme_g_nav_prev ?? 0) > 0,
        }
      : null,
    capClassification: {
      lastSyncedAt: capLastSyncedAt,
      counts: capCounts,
      stocks: capStocks,
      manualOverrideCount,
    },
    // Full state rows are reused for LogCreditEventCard's amount hints and
    // the NPS split-confirmation message. Cast is safe because the query
    // is `select("*")` and both tables' schemas are stable (a drift would
    // break the settings page long before it noticed here).
    epfState: (epfRes.data as EpfState) ?? null,
    npsState: (npsRes.data as NpsState) ?? null,
    indexLevels,
  };
}

// ─── Settings page ─────────────────────────────────────────────────────────

export async function getSettingsData(): Promise<SettingsData> {
  // NB: retirement_credits are no longer read here. They used to feed the
  // "Recent EPF/NPS credits" sidebar inside EpfCard/NpsContribCard, but
  // that sidebar was retired when the log-credit form itself moved to
  // /sync (see components/sync/LogCreditEventCard.tsx). The /credits page
  // is now the single source of truth for the ledger view.
  const [nps, epf, config, funds] = await Promise.all([
    sb.from("nps_state").select("*").eq("id", 1).maybeSingle(),
    sb.from("epf_state").select("*").eq("id", 1).maybeSingle(),
    fetchConfigMap(),
    sb.from("fund_holdings").select("fund_code").order("fund_code"),
  ]);
  if (nps.error) throw nps.error;
  if (epf.error) throw epf.error;
  if (funds.error) throw funds.error;

  let rotation: Record<string, string> = { Mon: "", Tue: "", Wed: "", Thu: "", Fri: "" };
  try {
    if (config.v5_rotation) rotation = { ...rotation, ...JSON.parse(config.v5_rotation) };
  } catch {}

  return {
    nps: (nps.data as NpsState) ?? null,
    epf: (epf.data as EpfState) ?? null,
    config,
    rotation,
    fundCodes: (funds.data ?? []).map((f) => f.fund_code as string),
    v6StartDate: config.v6_start_date ?? null,
  };
}

// ─── Credits page ──────────────────────────────────────────────────────────

/**
 * Map CAS `tx_type` values to the Groww `order_type` vocabulary the
 * UI already understands. Keeps `MfContributionsLog` free of any
 * source-specific branching for the primary kind classification.
 *
 * SIP registration / cancellation rows carry amount=0 and have no
 * economic effect on portfolio value — we surface them as null-typed
 * so the log's `orderKind()` matcher collapses them to `"other"`.
 * They still appear in the ledger for audit purposes.
 */
function casTxTypeToOrderType(txType: string | null): string | null {
  switch (txType) {
    case "purchase":
      return "PURCHASE";
    case "redemption":
      return "REDEMPTION";
    case "switch_in":
      return "SWITCH_IN";
    case "switch_out":
      return "SWITCH_OUT";
    case "dividend":
      return "DIVIDEND";
    case "sip_registration":
    case "sip_cancellation":
    case "other":
    default:
      return null;
  }
}

/** Row shape from `mf_transactions` — local because there's no
 *  page-wide MfTransaction type yet. Numeric columns come back as
 *  either number or string depending on the PostgREST client
 *  version, so we widen defensively and Number()-coerce on read. */
type MfTransactionRow = {
  tx_hash: string;
  tx_date: string;
  fund_code: string | null;
  folio_number: string | null;
  tx_type: string | null;
  amount: number | string | null;
  nav: number | string | null;
  units: number | string | null;
  scheme_name_raw: string | null;
  description_raw: string | null;
  platform: string | null;
  /** Row-level ingest source — 'mfcentral_cas' (RTA-reconciled) or
   *  'manual' (hand-typed or INDmoney bulk-paste). Distinct from the
   *  MfLedgerEntry.source discriminated union which normalises this
   *  into 'cas' | 'manual' for the UI layer. */
  source: string | null;
  /** Click date (INDmoney Subtitle1 or user input) when the order was
   *  placed. Distinct from tx_date (NAV date). See migration
   *  2026-07-24-mf-transactions-placed-date.sql. Null for CAS rows
   *  and legacy manual rows that pre-date this column. */
  placed_date: string | null;
};

/** Row shape from `mf_contributions` — mirrors the select statement
 *  below. Local for the same reason as MfTransactionRow. */
type MfContribRow = {
  order_id: string;
  fund_code: string | null;
  scheme_name: string | null;
  folio_number: string | null;
  order_type: string | null;
  order_status: string | null;
  order_date: string;
  placed_at: string | null;
  completion_date: string | null;
  amount_inr: number | string | null;
  units: number | string | null;
  nav: number | string | null;
  platform: string | null;
};

/**
 * Shared fetch primitive — returns the MF ledger as a single sorted
 * `MfLedgerEntry[]` unioned across both source tables.
 *
 * WHY THIS LIVES SEPARATE FROM getCreditsData
 * ───────────────────────────────────────────
 * Two callers need the union:
 *   • getCreditsData — for the Credits page log + current-month totals
 *   • getOverviewData — for ledger-truth cumulative deposits on the
 *     MF Attribution chart
 * Extracting keeps the union logic (source normalisation, disjoint
 * merge, sort) in one place so bugs get fixed once.
 *
 * Errors are logged but not thrown — a missing migration in either
 * table degrades to "no rows from that source" rather than blowing
 * up either page.
 */
// Exported (was private) so /studio's server action can reuse the
// exact same union-and-dedup pipeline that Overview and Credits rely
// on. Any bug fix or dedup rule change lands here once and every
// caller benefits. Studio applies its own additional filter on top
// (platform !== 'test') so headline math stays isolated from
// rehearsal rows.
export async function fetchMfLedger(): Promise<MfLedgerEntry[]> {
  // `platform` column was added by 2026-07-24-mf-platform.sql. On a
  // pre-migration DB the select would fail with 42703 (undefined
  // column) / PGRST204. We fall back to a no-platform reselect in that
  // case so the ledger keeps rendering — every row just shows
  // platform: null (which the badge component treats as "Unknown").
  // Paginated: both source tables grow monotonically. mf_transactions
  // in particular is projected to cross 1000 rows in ~2-4 years at
  // current purchase-heavy write patterns (~200-500 rows/year across 10
  // funds); mf_contributions is deprecated but still paginated for
  // consistency. Ordering is preserved across pages because .order()
  // is applied server-side before .range(). See the pagination-helper
  // block comment at the top of this file for context.
  const [mfContribRes, mfTxRes] = await Promise.all([
    fetchAllPagesResult<MfContribRow>((from, to) =>
      sb
        .from("mf_contributions")
        .select(
          "order_id,fund_code,scheme_name,folio_number,order_type,order_status,order_date,placed_at,completion_date,amount_inr,units,nav,platform"
        )
        .order("order_date", { ascending: false })
        .order("placed_at", { ascending: false })
        .range(from, to)
    ),
    fetchAllPagesResult<MfTransactionRow>((from, to) =>
      sb
        .from("mf_transactions")
        .select(
          "tx_hash,tx_date,fund_code,folio_number,tx_type,amount,nav,units,scheme_name_raw,description_raw,platform,source,placed_date"
        )
        .order("tx_date", { ascending: false })
        .range(from, to)
    ),
  ]);

  let contribRows: MfContribRow[] = [];
  if (mfContribRes.error) {
    const code = (mfContribRes.error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204") {
      // Fallback re-read (pre-migration schema, platform column
      // missing) — also paginated so pre-migration DBs at scale don't
      // silently truncate.
      const fallback = await fetchAllPagesResult<Omit<MfContribRow, "platform">>(
        (from, to) =>
          sb
            .from("mf_contributions")
            .select(
              "order_id,fund_code,scheme_name,folio_number,order_type,order_status,order_date,placed_at,completion_date,amount_inr,units,nav"
            )
            .order("order_date", { ascending: false })
            .order("placed_at", { ascending: false })
            .range(from, to)
      );
      if (!fallback.error) {
        contribRows = fallback.data.map((r) => ({ ...r, platform: null }));
        console.warn(
          "[queries] mf_contributions.platform column missing — apply " +
            "migration 2026-07-24-mf-platform.sql. Falling back to " +
            "no-platform read."
        );
      } else {
        throw fallback.error;
      }
    } else if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] mf_contributions table missing — apply migration " +
          "2026-07-18-mf-contributions.sql."
      );
    } else {
      throw mfContribRes.error;
    }
  } else {
    contribRows = mfContribRes.data as MfContribRow[];
  }

  let txRows: MfTransactionRow[] = [];
  if (mfTxRes.error) {
    const code = (mfTxRes.error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204") {
      // Either `platform` (migration 2026-07-24-mf-platform) or
      // `placed_date` (migration 2026-07-24-mf-transactions-placed-
      // date) or both may be missing on a partially-migrated DB.
      // Postgres surfaces only the first missing column in the 42703
      // error, so we can't tell which — instead we do a minimal
      // reselect without both, then null-fill the missing fields.
      // Cheaper than a probe-first strategy and self-healing: once
      // both migrations land, the primary select above succeeds and
      // this fallback path never runs.
      //
      // Paginated for the same reason as the primary read above.
      const fallback = await fetchAllPagesResult<
        Omit<MfTransactionRow, "platform" | "placed_date">
      >((from, to) =>
        sb
          .from("mf_transactions")
          .select(
            "tx_hash,tx_date,fund_code,folio_number,tx_type,amount,nav,units,scheme_name_raw,description_raw,source"
          )
          .order("tx_date", { ascending: false })
          .range(from, to)
      );
      if (!fallback.error) {
        txRows = fallback.data.map((r) => ({
          ...r,
          platform: null,
          placed_date: null,
        }));
        console.warn(
          "[queries] mf_transactions is missing platform and/or " +
            "placed_date column — apply migrations " +
            "2026-07-24-mf-platform.sql and 2026-07-24-mf-transactions-" +
            "placed-date.sql. Falling back to no-platform/no-placed-" +
            "date read."
        );
      } else {
        throw fallback.error;
      }
    } else if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] mf_transactions table missing — apply migration " +
          "2026-07-18-mf-transactions.sql."
      );
    } else {
      throw mfTxRes.error;
    }
  } else {
    txRows = mfTxRes.data as MfTransactionRow[];
  }

  const grownEntries: MfLedgerEntry[] = contribRows.map((r) => ({
    id: r.order_id,
    source: "groww",
    fund_code: r.fund_code,
    scheme_name: r.scheme_name,
    order_type: r.order_type,
    order_status: r.order_status,
    order_date: r.order_date,
    placed_at: r.placed_at,
    // Groww's mf_contributions carries `placed_at` (timestamptz) with
    // full time-of-day, so the ledger UI derives its "Placed" date
    // display from placed_at, not from placed_date. Leaving this null
    // for Groww rows keeps the two sources cleanly separable — Groww
    // = time-precise, INDmoney = date-only.
    placed_date: null,
    completion_date: r.completion_date,
    amount_inr: r.amount_inr == null ? null : Number(r.amount_inr),
    units: r.units == null ? null : Number(r.units),
    nav: r.nav == null ? null : Number(r.nav),
    folio_number: r.folio_number,
    platform: r.platform,
  }));

  const casEntries: MfLedgerEntry[] = txRows.map((r) => ({
    id: r.tx_hash,
    // Discriminated on the DB `source` column so manual/INDmoney rows
    // in mf_transactions surface as 'manual' — not the hardcoded 'cas'
    // that this branch used to emit for every row in this table.
    // Unknown/legacy source values collapse to 'manual' (safer default
    // than 'cas', which would misleadingly imply RTA reconciliation).
    source: r.source === "mfcentral_cas" ? "cas" : "manual",
    fund_code: r.fund_code,
    scheme_name: r.scheme_name_raw,
    order_type: casTxTypeToOrderType(r.tx_type),
    order_status: null,
    order_date: r.tx_date,
    placed_at: null,
    placed_date: r.placed_date,
    completion_date: null,
    amount_inr: r.amount == null ? null : Number(r.amount),
    units: r.units == null ? null : Number(r.units),
    nav: r.nav == null ? null : Number(r.nav),
    folio_number: r.folio_number,
    platform: r.platform,
  }));

  // Dedup CAS vs (Groww + Manual) for the SAME trade.
  //
  // Three ingest sources record the same purchase from their own
  // perspective, on different timelines:
  //   • Groww    — its own order (created at t=0, marked COMPLETED
  //                 at ~t+1d). Rows land in mf_contributions.
  //   • Manual   — hand-typed or INDmoney bulk/detail paste; also
  //                 lands in mf_transactions with source='manual'.
  //                 Represents the user's best-known view BEFORE
  //                 CAS confirmation.
  //   • CAS      — the RTA-side settlement snapshot (post-allotment)
  //                 from MFCentral eCAS. Lands in mf_transactions
  //                 with source='mfcentral_cas'. RTA-authoritative.
  //
  // MFCentral's eCAS now includes demat units too (KFin's statement
  // reports every unit under a subscriber's PAN regardless of holding
  // mode), so a Groww demat order at 17 Jul shows up in mf_contributions
  // AND in mf_transactions once CAS is refreshed. Same for an INDmoney
  // order — it'll be in mf_transactions twice: once as source='manual'
  // (from the INDmoney paste) and once as source='mfcentral_cas' (from
  // the eventual CAS refresh). Without dedup, the ledger would show
  // the same trade twice for INDmoney and once for Groww-then-CAS.
  //
  // The intended dedup point was CAS ingest deleting overlapping rows
  // in its date window at write time, but (a) the CAS UI was removed
  // and CLI re-imports don't sweep manual rows, and (b) even if they
  // did, the delete has a race with pastes that happen after the CAS
  // window. Defensive fetch-time dedup catches both cases without any
  // DB writes.
  //
  // Match key: (fund_code, order_date, rounded amount, rounded units).
  // Amount alone would collapse a same-day ₹10K purchase + ₹10K lumpsum;
  // adding units disambiguates. Fund_code prevents cross-scheme
  // collisions when two funds transact for identical amounts on the
  // same day (unusual but possible with weekly recurring purchases).
  //
  // CAS wins because it's RTA-authoritative — folio number is real,
  // NAV came from the source of truth (KFin), and the row won't
  // change status any further. Both Groww's and Manual's versions
  // add no info once reconciled by CAS. Manual rows lose their
  // INDmoney-specific detail (TxnID linkage) at display time — that's
  // acceptable because the underlying manual row stays in
  // mf_transactions for audit; the fold is purely for what the ledger
  // renders.
  //
  // WHY WE ONLY BUILD keys FROM cas SOURCE ROWS (not the whole
  // casEntries variable, which mixes CAS + manual):
  // ────────────────────────────────────────────────────
  // Two distinct INDmoney orders for identical fund/date/amount/units
  // would produce the SAME dedup key (see hash-fix note in
  // computeMfTxHash — that fix distinguishes them at the DB level via
  // source_ref-salted hash, but ledgerDedupKey deliberately omits
  // source_ref because it needs to match across sources for CAS↔manual
  // reconciliation). If we built keys from all casEntries, the second
  // manual row would see its own key already in the set (from the
  // first manual row) and vanish. Restricting the key-source to true
  // CAS rows preserves the "two distinct INDmoney orders both survive"
  // guarantee while still folding manual↔CAS pairs.
  const casKeys = new Set<string>();
  for (const c of casEntries) {
    if (c.source !== "cas") continue;
    const key = ledgerDedupKey(c);
    if (key) casKeys.add(key);
  }
  const manualDeduped: MfLedgerEntry[] = [];
  for (const m of casEntries) {
    if (m.source === "cas") {
      manualDeduped.push(m);
      continue;
    }
    const key = ledgerDedupKey(m);
    if (key && casKeys.has(key)) continue; // CAS wins over manual
    manualDeduped.push(m);
  }
  const grownDeduped: MfLedgerEntry[] = [];
  for (const g of grownEntries) {
    const key = ledgerDedupKey(g);
    if (key && casKeys.has(key)) continue; // CAS wins over Groww
    grownDeduped.push(g);
  }

  // Sort by order_date DESC then by source (CAS first) for deterministic
  // ordering — helps the UI show settled events above pending ones on
  // the same day.
  return [...manualDeduped, ...grownDeduped].sort((a, b) => {
    if (a.order_date !== b.order_date) {
      return a.order_date < b.order_date ? 1 : -1;
    }
    if (a.source !== b.source) return a.source === "cas" ? -1 : 1;
    return 0;
  });
}

/**
 * Fingerprint one MfLedgerEntry so identical trades from CAS +
 * (Groww or Manual/INDmoney) collapse to a single key at read time.
 * Returns null when any component is missing — that row is
 * defensively excluded from dedup (better to show two nearly-
 * identical rows than accidentally merge distinct trades).
 *
 * KEY COMPONENTS
 * ──────────────
 *   fund_code   — scheme identity. Different funds transacting for
 *                  identical amounts on the same day must not fold.
 *   order_date  — trade day (NAV date, aligned across sources by the
 *                  earlier tx_date semantics: CAS convention = NAV
 *                  day, manual convention = NAV day after
 *                  resolveNavDate has rolled post-cutoff orders).
 *   amount      — SIGNED gross amount rounded to nearest rupee.
 *                  Signed so a same-day BUY + SELL of the same fund
 *                  for the same absolute rupees don't collide
 *                  (redemption stores as negative). Rounded to rupee
 *                  because Groww sometimes carries the paisa
 *                  remainder (₹9,999.50 = ₹10,000 orderVal minus
 *                  ₹0.50 stamp duty) while CAS reports the net.
 *
 * WHY UNITS ARE INTENTIONALLY EXCLUDED FROM THE FINGERPRINT
 * ─────────────────────────────────────────────────────────
 * Same reason units are excluded from computeMfTxHash: the AMC's
 * actual allotted units differ from a naive amount/NAV calculation
 * by ~1 milli-unit because the AMC's internal NAV precision extends
 * beyond CAS's 4-dp reporting. For the specific INDmoney↔CAS pair
 * this manifests as:
 *   • Manual row units (computed): 9999.50 / 126.20 = 79.2353
 *   • CAS row units (RTA-truth):   79.238
 *   • Even at 3-dp rounding these differ (79.235 vs 79.238).
 * Including units in the fingerprint would prevent the fold and
 * leave both rows visible in the ledger — defeating the whole
 * purpose of CAS reconciliation.
 *
 * COLLISION SAFETY WITHOUT UNITS
 * ──────────────────────────────
 * Two DISTINCT trades sharing (fund, date, signed amount) — e.g. two
 * ₹10K purchases of EDEL_MID on the same day — are technically at
 * risk of collapsing in this fingerprint. That's fine here because:
 *   • The DB-level (source, tx_hash) constraint distinguishes them
 *     when both carry a source_ref (the post-2026-07-24 hash fix
 *     salts hash with source_ref → distinct hashes → both survive).
 *   • The read-time dedup only DROPS a row when its fingerprint
 *     matches an existing CAS row's fingerprint. Two manual rows
 *     with the same fingerprint don't dedup against each other in
 *     this code path (see the two-phase build in fetchMfLedger).
 *   • Two CAS rows with the same fingerprint (from two real distinct
 *     trades) both survive too — the CAS-key set uses Set semantics
 *     but the CAS rows themselves are all pushed unconditionally.
 */
function ledgerDedupKey(entry: MfLedgerEntry): string | null {
  if (!entry.fund_code || entry.amount_inr == null) return null;
  const amount = Math.round(entry.amount_inr);
  return `${entry.fund_code}|${entry.order_date}|${amount}`;
}

/**
 * Build a per-date lookup of cumulative net deposits (purchases minus
 * redemptions) from a sorted-DESC ledger. Used by getOverviewData to
 * enrich each NwRow with a ledger-derived deposit total, which powers
 * a true historical curve on the MF Attribution chart.
 *
 * Why NET (not just purchases): redemptions are money OUT and reduce
 * the deposit baseline for market-attribution purposes. Someone who
 * deposits ₹10L then redeems ₹2L has ₹8L "at risk" — market return
 * should be attributed against that ₹8L, not ₹10L.
 *
 * SWITCH_IN / SWITCH_OUT are ignored — they're internal rebalances
 * with no external money movement, so they don't shift the deposit
 * baseline. Their net contribution across the pair is zero anyway.
 *
 * DIVIDEND rows are also ignored for the deposit series — dividends
 * are returns generated on the corpus, not new money. Including them
 * would double-count (dividend paid out then reinvested inflates
 * cumDeposits) or, worse, understate market gain.
 */
function buildCumulativeDepositMap(entries: MfLedgerEntry[]): Map<string, number> {
  // Sum per-date net deposits first (multiple orders on the same
  // day collapse to a single date entry).
  const perDate = new Map<string, number>();
  for (const e of entries) {
    if (!e.amount_inr || !e.order_date) continue;
    let signed = 0;
    if (e.order_type === "PURCHASE") signed = e.amount_inr;
    else if (e.order_type === "REDEMPTION") signed = -e.amount_inr;
    // Switches, dividends, nulls → 0
    if (signed === 0) continue;
    perDate.set(e.order_date, (perDate.get(e.order_date) ?? 0) + signed);
  }
  // Cumulative rollup in ascending date order.
  const cumulative = new Map<string, number>();
  const sortedDates = [...perDate.keys()].sort();
  let running = 0;
  for (const d of sortedDates) {
    running += perDate.get(d) ?? 0;
    cumulative.set(d, running);
  }
  return cumulative;
}

/**
 * Given a per-date deposit map (from `buildCumulativeDepositMap`) and
 * a target date, return the cumulative deposits AS OF that date —
 * i.e. the most recent entry ≤ target. Uses a simple linear walk
 * on the sorted date array; for our data volumes (< 5k rows) this
 * is cheaper than binary search.
 */
function cumulativeDepositsAsOf(
  cumMap: Map<string, number>,
  sortedDates: string[],
  target: string
): number {
  let last = 0;
  for (const d of sortedDates) {
    if (d > target) break;
    last = cumMap.get(d) ?? last;
  }
  return last;
}

// ─── NPS reconstruction helpers ────────────────────────────────────────────

type NpsTxRow = {
  tx_date: string;
  tier: string;
  scheme: string;
  tx_type: string;
  amount: number;
  nav: number | null;
  units: number | null;
};

type NpsNavRow = {
  scheme: string; // 'E' | 'C' | 'G'
  nav_date: string;
  nav: number;
};

/**
 * Fetch the Tier-I NPS transaction ledger. Analogous to `fetchMfLedger`.
 *
 * Missing table degrades to [] with a console warning (same
 * pattern as fetchMfLedger). Getting an empty array here just means
 * the NPS reconstruction step will produce no rows — the chart will
 * fall back to nw_daily-only observed history, same graceful-degradation
 * story as the MF side.
 *
 * We fetch ALL rows (not just cash-generating ones) because scheme-
 * preference switches, though net-zero in cash terms, do move units
 * between E/C/G. The daily reconstruction needs those to keep the
 * per-scheme unit balances honest even when the cash total doesn't
 * budge. Filtering happens downstream in buildNpsDailyHistory.
 */
async function fetchNpsLedger(): Promise<NpsTxRow[]> {
  const res = await sb
    .from("nps_transactions")
    .select("tx_date,tier,scheme,tx_type,amount,nav,units")
    .eq("tier", "I")
    .order("tx_date", { ascending: true });
  if (res.error) {
    const code = (res.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] nps_transactions table missing — apply migration " +
          "2026-07-18-nps-transactions.sql."
      );
      return [];
    }
    throw res.error;
  }
  return (res.data ?? []).map((r) => ({
    tx_date: r.tx_date,
    tier: r.tier,
    scheme: r.scheme,
    tx_type: r.tx_type,
    amount: Number(r.amount),
    nav: r.nav == null ? null : Number(r.nav),
    units: r.units == null ? null : Number(r.units),
  }));
}

/**
 * Fetch the daily NAV history for the three POP-variant Kotak Tier I
 * schemes. Missing table degrades to [] (same pattern as
 * mf_daily_reconstructed).
 *
 * MUST paginate — nps_nav_history has ~2,900 rows per scheme (12 years
 * of daily NAVs × 3 schemes ≈ 8,700 rows), well past the project's
 * db-max-rows=1000 PostgREST cap. Without fetchAllPages() the query
 * silently returns only the first 1000 rows (roughly the first year of
 * data, 2014-2015), which makes buildNpsDailyHistory forward-fill a
 * decade-stale NAV for every reconstructed day and produces an obvious
 * value/invested chart with value at ~35% of invested. See the helper
 * comment at the top of this file for the full story.
 */
async function fetchNpsNavHistory(): Promise<NpsNavRow[]> {
  try {
    const rows = await fetchAllPages<{
      scheme: string;
      nav_date: string;
      nav: number | string;
    }>((from, to) =>
      sb
        .from("nps_nav_history")
        .select("scheme,nav_date,nav")
        .in("scheme", ["E", "C", "G"])
        .order("nav_date", { ascending: true })
        .range(from, to)
    );
    return rows.map((r) => ({
      scheme: r.scheme,
      nav_date: r.nav_date,
      nav: Number(r.nav),
    }));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[queries] nps_nav_history table missing — apply migration " +
          "2026-07-19-nps-nav-history.sql and run scripts/backfill-nps-nav-history.ts."
      );
      return [];
    }
    throw err;
  }
}

/**
 * Tier I NPS XIRR — money-weighted return across every real contribution
 * / withdrawal event, plus a terminal "what it's worth today" flow.
 *
 * Sign translation: `nps_transactions.amount` is signed from the CORPUS's
 * perspective (positive = money added to corpus, negative = money removed
 * — see 2026-07-18-nps-transactions.sql's header). XIRR needs the
 * INVESTOR's perspective (negative = left your pocket, positive = you
 * received it) — the exact opposite sign. Negating `amount` once handles
 * both tx_types correctly in one step:
 *   • contribution (DB: +5000, added to corpus)   → XIRR flow: -5000
 *   • withdrawal   (DB: -3000, removed from corpus) → XIRR flow: +3000
 *
 * Deliberately excludes:
 *   • billing        — a fee deducted via unit redemption. Already
 *     reflected in your reduced unit balance / terminal value; including
 *     it as a separate flow would double-count the fee drag.
 *   • switch_in / switch_out, shifting_in / shifting_out — money moving
 *     BETWEEN your own E/C/G schemes, not entering/leaving NPS. Net zero
 *     effect on the Tier I aggregate XIRR this function computes (a
 *     per-scheme XIRR would treat these as real external flows, but
 *     nothing here does per-scheme).
 *   • other          — unclassified rows, excluded defensively rather
 *     than risk silently corrupting the cash-flow list.
 *
 * Returns null when there's insufficient data — see computeXirr's
 * contract (needs ≥2 flows, ≥2 distinct dates, and both signs present).
 * That covers "no contributions ingested yet" and "ledger table missing"
 * gracefully — the UI just omits the XIRR badge in that case.
 */
function computeNpsXirr(
  txRows: NpsTxRow[],
  asOfDate: string | null,
  asOfValue: number | null
): number | null {
  const flows: CashFlow[] = txRows
    .filter((tx) => tx.tier === "I" && (tx.tx_type === "contribution" || tx.tx_type === "withdrawal"))
    .map((tx) => ({ date: tx.tx_date, amount: -tx.amount }));

  if (asOfDate && asOfValue != null && asOfValue > 0) {
    flows.push({ date: asOfDate, amount: asOfValue });
  }

  return computeXirr(flows);
}

/**
 * Reconstruct a daily NPS value + invested curve from three inputs:
 *   1. `nps_transactions` — the transaction ledger (cumulative units + cash)
 *   2. `nps_nav_history` — daily NAV per scheme (POP variant)
 *   3. `nwHistory` — observed nw_daily snapshots (for date union +
 *      preferred value on overlap)
 *
 * Algorithm
 * ─────────
 * 1. Sum units per (scheme, tx_date) so multiple tx on the same day
 *    collapse cleanly. Same for cash amount (contributions only —
 *    billing is a fee, switches net to zero over the settlement gap
 *    (see step 2 caveat), withdrawals are rare and would go here too
 *    if present).
 * 2. Walk the union of all NAV dates and observed dates in ascending
 *    order. On each date, carry forward the running unit balance per
 *    scheme (applying any new tx units), look up NAV per scheme
 *    (forward-fill the last known NAV if the current date is a
 *    holiday for one scheme but not another), and compute
 *    `nps_value = Σ(units × nav) + pendingSwitchCash`.
 *
 *    Inter-scheme switches: CRA books `switch_out` on day T (units
 *    leave the source scheme) but the compensating `switch_in` only
 *    lands on day T+2 (units allotted to destination schemes). During
 *    that gap the money is held "in transit" by CRA — user's real
 *    corpus is unchanged, but a naive Σ(units × nav) would show a
 *    ~switch-sized dip. `pendingSwitchCash` bridges the gap: it
 *    absorbs the switch_out rupees and drains back to zero on the
 *    matching switch_in. In equilibrium the term contributes nothing.
 * 3. `nps_invested` is a step function that jumps on contribution
 *    dates and stays flat between them. Switches don't affect it
 *    (internal moves, not new cash).
 * 4. On dates that also appear in observed `nwHistory`, prefer the
 *    observed `nps_value` (Kotak's authoritative same-day close) over
 *    the reconstructed one. Small drift is expected between the two
 *    (reconstructed uses npsnav.in NAVs which lag Kotak by ~1 day) —
 *    observed always wins.
 *
 * Coverage
 * ────────
 * First row = first NAV date on/after first tx date (typically 1-2 days
 * after the initial contribution, since NPS credits units at NAV of
 * the credit date). Last row = today (last observed nw_daily row) or
 * last NAV date, whichever is more recent.
 *
 * Missing NAV history entirely → returns []. Callers can fall back
 * to observed-only nw_daily-derived rows.
 */
function buildNpsDailyHistory(
  txRows: NpsTxRow[],
  navRows: NpsNavRow[],
  nwHistory: NwRow[]
): NpsDailyRow[] {
  if (navRows.length === 0) return [];

  // Bucket NAVs per scheme, sorted ascending by date. Used to
  // forward-fill NAV values on holidays / non-trading days.
  const navByScheme: Record<"E" | "C" | "G", NpsNavRow[]> = {
    E: [],
    C: [],
    G: [],
  };
  for (const r of navRows) {
    if (r.scheme === "E" || r.scheme === "C" || r.scheme === "G") {
      navByScheme[r.scheme].push(r);
    }
  }

  // Bucket tx per date (all schemes together) — we iterate day by day
  // and apply every tx that landed on that day. Cheaper than a per-day
  // filter over the whole tx list.
  const txByDate = new Map<string, NpsTxRow[]>();
  for (const tx of txRows) {
    const arr = txByDate.get(tx.tx_date) ?? [];
    arr.push(tx);
    txByDate.set(tx.tx_date, arr);
  }

  // Union of every date we care about: (all NAV dates) ∪ (all observed
  // nw_daily dates) ∪ (all tx dates — usually a subset of NAV dates
  // but included defensively in case a tx sits on a day npsnav.in
  // didn't publish, which happens for month-end holidays).
  const dateSet = new Set<string>();
  for (const r of navRows) dateSet.add(r.nav_date);
  for (const r of nwHistory) dateSet.add(r.date);
  for (const d of txByDate.keys()) dateSet.add(d);
  const allDates = [...dateSet].sort();

  // Anchor the series to the first tx date — pre-tx dates would have
  // 0 units and 0 value across the board, which just clutters the
  // chart. If we have NAV history but no tx yet, the chart would be
  // meaningless anyway.
  const firstTxDate = txRows[0]?.tx_date;
  if (!firstTxDate) return [];

  // NAV forward-fill state — remember the last NAV seen per scheme so
  // we can carry it forward on missing days.
  const lastNav: Record<"E" | "C" | "G", number> = { E: 0, C: 0, G: 0 };
  const navIdx: Record<"E" | "C" | "G", number> = { E: 0, C: 0, G: 0 };
  const advanceNavCursors = (targetDate: string) => {
    for (const s of ["E", "C", "G"] as const) {
      const arr = navByScheme[s];
      while (navIdx[s] < arr.length && arr[navIdx[s]].nav_date <= targetDate) {
        lastNav[s] = arr[navIdx[s]].nav;
        navIdx[s]++;
      }
    }
  };

  // Running state: cumulative units per scheme, cumulative contributions.
  const units: Record<"E" | "C" | "G", number> = { E: 0, C: 0, G: 0 };
  let invested = 0;
  // Inter-scheme switches settle T+2 in the CRA ledger — the source
  // scheme's units drop on `switch_out` day, but the destination
  // scheme's units only rise on `switch_in` day (usually 2 business
  // days later). During that window the money is held "in transit"
  // by CRA and the user's real portfolio value is unchanged, but a
  // naive units×NAV product would show a spurious dip of roughly
  // the switch amount (see 15-17 Jun 2026 in this codebase's history
  // for a concrete example). `pendingSwitchCash` tracks that in-
  // transit rupee amount so the reconstructed value stays flat
  // through the settlement gap.
  //
  // Sign convention: switch_out rows have negative `amount` (money
  // leaving the source scheme, mirroring CRA's export), switch_in
  // rows have positive `amount`. We add `-amount` on switch_out
  // (flips to positive → grows the pending pool) and subtract
  // `amount` on switch_in (drains the pool as units get allotted).
  // In equilibrium the pool sits at zero and this term vanishes
  // from `reconValue`.
  let pendingSwitchCash = 0;

  // Observed nw_daily lookup for preferring observed values on overlap.
  const observedMap = new Map<string, number>();
  for (const r of nwHistory) observedMap.set(r.date, r.nps_value);

  const rows: NpsDailyRow[] = [];
  for (const date of allDates) {
    if (date < firstTxDate) continue;

    // Apply every tx that landed on this date.
    const txs = txByDate.get(date);
    if (txs) {
      for (const tx of txs) {
        const scheme = tx.scheme as "E" | "C" | "G";
        if (scheme !== "E" && scheme !== "C" && scheme !== "G") continue;
        if (tx.units != null) units[scheme] += Number(tx.units);
        // Contribution and withdrawal are the only tx types that
        // change external cash flow (`invested`). Billing is a fee
        // (small negative amounts, doesn't reduce invested baseline).
        // Switches don't touch `invested` — they're internal moves —
        // but they DO temporarily displace value across the T+2
        // settlement gap, tracked via `pendingSwitchCash` below.
        if (tx.tx_type === "contribution") invested += tx.amount;
        else if (tx.tx_type === "withdrawal") invested += tx.amount;
        else if (tx.tx_type === "switch_out") pendingSwitchCash += -tx.amount;
        else if (tx.tx_type === "switch_in") pendingSwitchCash -= tx.amount;
      }
    }

    advanceNavCursors(date);
    // If we haven't seen a NAV for a scheme yet on this date, the
    // last-known-NAV is 0, which would zero out that scheme's value
    // contribution. That only happens if the tx landed before the
    // earliest NAV in nps_nav_history — vanishingly rare (Kotak POP
    // has NAVs back to 2009), and if it happens we just skip the row
    // rather than emitting a bogus 0-value point.
    if (lastNav.E === 0 && lastNav.C === 0 && lastNav.G === 0) continue;

    const reconValue =
      units.E * lastNav.E +
      units.C * lastNav.C +
      units.G * lastNav.G +
      pendingSwitchCash;
    const observed = observedMap.get(date);
    const isObserved = observed !== undefined;
    // Observed > reconstructed when both exist — Kotak's authoritative
    // close from the day beats npsnav.in's next-day-published value.
    const nps_value = isObserved ? observed : reconValue;

    const nps_gain_pct =
      invested > 0 ? ((nps_value - invested) / invested) * 100 : null;

    rows.push({
      date,
      nps_value,
      nps_invested: invested,
      nps_gain_pct,
      is_reconstructed: !isObserved,
    });
  }

  return rows;
}

export async function getCreditsData(): Promise<CreditsPageData> {
  const today = new Date();
  const currentYear = today.getUTCFullYear();
  const currentMonth = today.getUTCMonth();

  const currentMonthStart = new Date(Date.UTC(currentYear, currentMonth, 1))
    .toISOString()
    .slice(0, 10);

  // Two independent fetches. `fetchMfLedger` handles its own error
  // degradation (missing tables → empty), so we only need explicit
  // handling here for the retirement_credits fetch.
  const [creditsRes, mfLedger] = await Promise.all([
    sb
      .from("retirement_credits")
      .select("*")
      .order("credit_date", { ascending: false }),
    fetchMfLedger(),
  ]);

  // Handle retirement_credits errors — same code-based degradation
  // as before so the page still boots without the migration applied.
  let credits: RetirementCredit[] = [];
  if (creditsRes.error) {
    const code = (creditsRes.error as { code?: string }).code;
    if (code !== "42P01" && code !== "PGRST205") throw creditsRes.error;
    console.warn(
      "[queries] retirement_credits table missing — apply migration " +
        "2026-07-16-retirement-credits-ledger.sql."
    );
  } else {
    credits = (creditsRes.data ?? []) as RetirementCredit[];
  }

  // Quick indicator: has THIS month's payroll been logged for each source?
  // Purely informational; used by the /credits page banner to nudge the
  // user when the current month's EPFO SMS has arrived but hasn't been
  // logged yet.
  const epfPayroll = credits.some(
    (c) =>
      c.source === "EPF" &&
      c.credit_type === "payroll" &&
      c.credit_date >= currentMonthStart
  );
  const npsPayroll = credits.some(
    (c) =>
      c.source === "NPS" &&
      c.credit_type === "payroll" &&
      c.credit_date >= currentMonthStart
  );

  // Current-month totals for the headline strip. MF total sums every
  // PURCHASE-typed ledger entry this month — includes both Groww
  // pending orders (already committed cash) and CAS settled events.
  const currentMonthTotals = {
    epfInr: credits
      .filter((c) => c.source === "EPF" && c.credit_date >= currentMonthStart)
      .reduce((s, c) => s + Number(c.amount_inr ?? 0), 0),
    npsInr: credits
      .filter((c) => c.source === "NPS" && c.credit_date >= currentMonthStart)
      .reduce((s, c) => s + Number(c.amount_inr ?? 0), 0),
    mfInr: mfLedger
      .filter(
        (m) => m.order_date >= currentMonthStart && m.order_type === "PURCHASE"
      )
      .reduce((s, m) => s + Number(m.amount_inr ?? 0), 0),
  };

  // Pending count stays Groww-scoped by design — CAS rows are always
  // settled at ingest time (`order_status=null`). Filter matches
  // non-null, non-COMPLETED Groww rows.
  const mfPendingCount = mfLedger.filter(
    (m) =>
      m.source === "groww" &&
      m.order_status !== "COMPLETED" &&
      m.order_status !== null
  ).length;

  return {
    credits,
    currentMonthByType: { epfPayroll, npsPayroll },
    mfLedger,
    currentMonthTotals,
    mfPendingCount,
  };
}
