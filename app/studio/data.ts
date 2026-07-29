"use server";

import { sbServer as sb } from "@/lib/supabase";
import {
  fetchAllPagesResult,
  fetchMfLedger,
  type MfLedgerEntry,
} from "@/lib/queries";

/**
 * app/studio/data.ts
 *
 * Server action that hydrates the /studio reveal state (growth chart
 * + six-tile stats grid). Lives in a dedicated file rather
 * than piggy-backing on `getOverviewData` because:
 *
 *   • Studio only needs a small slice — MF-only, no NPS/EPF/networth
 *     aggregation. Loading getOverviewData would pull ~15 queries and
 *     serialise a payload 20× larger than Studio's needs.
 *   • Studio applies a test-mode filter that Overview doesn't — every
 *     aggregation in this file excludes `platform='test'` rows so
 *     rehearsal submits during video-recording setup don't skew the
 *     numbers on camera.
 *   • The month-to-date deposits tally is Studio-specific UX;
 *     belongs here. (Earlier iterations of this file also computed
 *     Day-N, Today, Streak, and XIRR — removed 2026-07-28 once we
 *     realised none of them were pulling weight on-screen and XIRR
 *     was actively misleading for a <1-year-old portfolio.)
 *
 * The one shared primitive we DO reuse is `fetchMfLedger` — that
 * function encodes the CAS↔manual↔Groww dedup logic which we don't
 * want to re-implement (and which Studio benefits from equally). It
 * returns every row including test rows; we filter after.
 */

// ── Types ────────────────────────────────────────────────────────

export type StudioChartPoint = {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Cumulative NET deposits as of this date (₹). Ledger-derived
   *  from PURCHASE minus REDEMPTION amounts. Switches / dividends /
   *  test rows are excluded. */
  invested: number;
  /** MF portfolio value on this date (₹). Sourced from nw_daily for
   *  the tracking-era window and mf_daily_reconstructed for the
   *  pre-tracking backfill. nw_daily already excludes test rows
   *  (because logMfTransaction short-circuits its recomputeNwDaily
   *  side effect for platform='test').
   *
   *  NULL for dates BEFORE the first value snapshot lands — this
   *  can happen when the mf_daily_reconstructed backfill hasn't been
   *  run yet, or covers a narrower range than the ledger. Recharts
   *  renders these as gaps (empty space above the invested line)
   *  rather than as `0`, which would produce a misleading "portfolio
   *  worth zero" reading for the entire pre-value-data window. */
  value: number | null;
};

export type StudioData = {
  chart: StudioChartPoint[];
  stats: {
    /** Current MF value from fund_holdings.current_value_inr sum.
     *  Test rows never touch fund_holdings, so this is clean. */
    value: number;
    /** Current invested from fund_holdings.invested_inr sum. Also
     *  test-free by the same mechanism. */
    invested: number;
    /** Sum of `fund_holdings.one_day_change_inr` across every fund.
     *  Per-fund 1D is populated by refresh-mf-nav (units × ΔNAV
     *  from the previous NAV rotation), so this is a NAV-only,
     *  deposit-immune number. Same source of truth as the MF card
     *  on /overview. Null when no fund has published a 1D value
     *  yet (fresh install, or every fund is a T+1 overseas ETF
     *  waiting on tomorrow's NAV). */
    oneDayInr: number | null;
    /** Portfolio-scale 1D percentage: oneDayInr / (value − oneDayInr) × 100.
     *  Denominator is yesterday's value (today's value minus today's
     *  gain) so the ratio reads as "% return since yesterday", not
     *  "% of today's post-change value". Null when oneDayInr is null
     *  or the denominator collapses to ≤ 0. */
    oneDayPct: number | null;
    /** Sum of non-test purchase amounts in the current calendar
     *  month (₹). Merged into `stats` from the removed `progress`
     *  substructure on 2026-07-28 when the daily-progress card was
     *  folded into a single 6-tile stats grid. */
    monthInr: number;
    /** Count of non-test purchases in the current calendar month.
     *  Same source as monthInr. */
    monthCount: number;
    /** Lifetime count of successful, allotted PURCHASE rows across
     *  all sources (Groww + INDmoney + MFCentral CAS + manual).
     *  Every ledger row here has already been allotted — units and
     *  NAV are populated at insert time by each ingestion path, so
     *  "successful alloted" is the DB's default state. Test rows
     *  (platform='test') and non-purchase rows (REDEMPTION, SWITCH,
     *  DIVIDEND) are excluded. */
    totalOrders: number;
    /** Sum of amount_inr across every lifetime PURCHASE row (test-
     *  excluded). Used as the numerator for `avgOrderSize`. Kept
     *  separately from `invested` (from fund_holdings) because the
     *  two can diverge once redemptions land — `invested` is the
     *  NET current position (post-redemption), `totalPurchaseInr`
     *  is the GROSS lifetime money-in that better answers "how
     *  much do I typically put in per purchase". Currently equal
     *  to `invested` for the user's pre-redemption era. */
    totalPurchaseInr: number;
    /** Days between the earliest non-test PURCHASE date and today,
     *  clamped to ≥1 to avoid /0 in `dailyEarningRate`. Null when
     *  the ledger has no purchases yet (unlikely — the Studio page
     *  is only meaningful post-first-order). Uses IST local dates,
     *  same convention as the rest of the file. */
    daysInvested: number | null;
    /** Average purchase amount: totalPurchaseInr / totalOrders.
     *  Null when totalOrders is 0. Answers "how much do I typically
     *  put in per purchase order". Uses gross purchase amounts (see
     *  totalPurchaseInr) so redemptions don't retroactively shrink
     *  the historical average. Renamed from `avgSipSize` on
     *  2026-07-28 — only ICICI_NASDAQ in this portfolio is a real
     *  systematic-investment-plan; the rest are ad-hoc purchases,
     *  so the field takes the neutral "order" noun everywhere. */
    avgOrderSize: number | null;
    /** Passive-gain rate: (value − invested) / daysInvested. Null
     *  when daysInvested is null or ≤0. Frames unrealised gain as
     *  "your portfolio earned you ₹X per day just sitting there" —
     *  gets more impressive as compounding kicks in. Uses the same
     *  fund_holdings-derived gain that any external consumer would
     *  see, so the number stays in sync with /overview and the
     *  chart-pill's gain figure. */
    dailyEarningRate: number | null;
    /** Return-per-order: (value − invested) / totalOrders. Null
     *  when totalOrders is 0. Structural mirror of avgOrderSize —
     *  the two tiles read as "₹X in per order → ₹Y back per
     *  order", which is the whole reason they're placed side-by-
     *  side. Denominator is order count (not purchase amount) so
     *  units are ₹/order, not %. */
    profitPerOrder: number | null;
    /** Mirror of NEXT_PUBLIC_FUNDS_TEST_MODE so the client can
     *  show a subtle "figures exclude test rows" hint next to the
     *  stats row without re-reading the env var itself. */
    isTestMode: boolean;
  };
};

// ── Small local helpers ─────────────────────────────────────────

/** Today's date in India Standard Time as YYYY-MM-DD.
 *  IST-anchored so a user hitting the page just after midnight UTC
 *  still sees today as the current IST calendar day. */
function istTodayISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** The date this ledger entry counts as for progress-card metrics.
 *  Prefer `placed_date` (user-visible click date) so a post-cutoff
 *  order counts for the day you actually clicked Buy, not the
 *  following NAV day. Falls back to order_date. */
function effectiveDate(e: MfLedgerEntry): string {
  return e.placed_date ?? e.order_date;
}

// ── The action ──────────────────────────────────────────────────

export async function getStudioData(): Promise<StudioData> {
  const today = istTodayISO();
  // YYYY-MM slice for month-scoped aggregates.
  const thisMonth = today.slice(0, 7);

  // Parallel fetch — four independent queries.
  const [ledger, holdingsRes, reconstructedRes, nwRes] = await Promise.all([
    // Every MF row, deduped across sources. Test rows included; we
    // filter after so any downstream consumer of the same primitive
    // sees a consistent snapshot.
    fetchMfLedger(),
    // Current-snapshot totals for the stats row. Test-free by
    // construction (logMfTransaction short-circuits fund_holdings
    // updates for platform='test').
    //
    // one_day_change_inr is per-fund persistent 1D (units × ΔNAV
    // from the last NAV rotation), populated by refresh-mf-nav.
    // Summed here for the 1D tile. Same source of truth as the
    // /overview MF card so the two screens agree.
    sb
      .from("fund_holdings")
      .select("current_value_inr, invested_inr, one_day_change_inr"),
    // Pre-tracking daily value series (Jan → mid-Jul 2026). No test
    // rows possible here since it's built from historical CAS.
    //
    // Paginated: mf_daily_reconstructed grows 1 row/day; a plain
    // .select() would silently truncate at 1000 within ~2.2 years
    // and freeze the pre-tracking chart segment. See the pagination-
    // helper block comment in lib/queries.ts for the full story.
    fetchAllPagesResult<{
      date: string;
      mf_value_inr: number;
      mf_invested_inr: number;
    }>((from, to) =>
      sb
        .from("mf_daily_reconstructed")
        .select("date, mf_value_inr, mf_invested_inr")
        .order("date", { ascending: true })
        .range(from, to)
    ),
    // Post-tracking daily snapshot (mid-Jul 2026 → today). Test rows
    // don't reach nw_daily either because recomputeNwDaily is
    // gated on the same platform!='test' check.
    //
    // Paginated for the same reason as mf_daily_reconstructed above.
    fetchAllPagesResult<{
      date: string;
      mf_value: number;
      mf_invested: number;
    }>((from, to) =>
      sb
        .from("nw_daily")
        .select("date, mf_value, mf_invested")
        .order("date", { ascending: true })
        .range(from, to)
    ),
  ]);

  // Non-fatal degradation for optional tables. Missing reconstructed
  // = the chart just starts later; missing nw_daily = ditto. Both
  // are additive so no throw.
  if (reconstructedRes.error) {
    console.warn(
      `[studio.getStudioData] mf_daily_reconstructed read: ${reconstructedRes.error.message}`
    );
  }
  if (nwRes.error) {
    console.warn(
      `[studio.getStudioData] nw_daily read: ${nwRes.error.message}`
    );
  }
  if (holdingsRes.error) {
    console.warn(
      `[studio.getStudioData] fund_holdings read: ${holdingsRes.error.message}`
    );
  }

  const productionLedger = ledger.filter((e) => e.platform !== "test");

  // ── Stats row ────────────────────────────────────────────────
  // Sum current value + invested across every fund. one_day_change_inr
  // is nullable per fund (a fresh install or a T+1 overseas ETF
  // pending tomorrow's NAV publishes null), so we only sum the
  // subset that has published a 1D value and expose null when
  // none of them have. Matches the pattern used by getOverviewData
  // in lib/queries.ts (~L2137) so both screens stay in sync.
  let value = 0;
  let invested = 0;
  let oneDayInrAccum = 0;
  let oneDayFundCount = 0;
  for (const h of holdingsRes.data ?? []) {
    value += Number(h.current_value_inr ?? 0);
    invested += Number(h.invested_inr ?? 0);
    if (h.one_day_change_inr != null) {
      oneDayInrAccum += Number(h.one_day_change_inr);
      oneDayFundCount += 1;
    }
  }

  // Portfolio 1D: sum of per-fund NAV-only deltas. Percentage
  // uses (value − oneDayInr) as the denominator so it reads as
  // "% return since yesterday's close" — same convention as the
  // MF card on /overview and Groww's own display.
  const oneDayInr: number | null = oneDayFundCount > 0 ? oneDayInrAccum : null;
  const oneDayDenominator = oneDayInr != null ? value - oneDayInr : 0;
  const oneDayPct: number | null =
    oneDayInr != null && oneDayDenominator > 0
      ? (oneDayInr / oneDayDenominator) * 100
      : null;

  // ── Chart series ─────────────────────────────────────────────
  // Cumulative net deposits per date from the ledger.
  const investedPerDate = new Map<string, number>();
  for (const e of productionLedger) {
    if (!e.amount_inr || !e.order_date) continue;
    const signed =
      e.order_type === "PURCHASE"
        ? e.amount_inr
        : e.order_type === "REDEMPTION"
          ? -e.amount_inr
          : 0;
    if (signed === 0) continue;
    investedPerDate.set(
      e.order_date,
      (investedPerDate.get(e.order_date) ?? 0) + signed
    );
  }
  const cumInvestedByDate = new Map<string, number>();
  {
    let running = 0;
    for (const d of [...investedPerDate.keys()].sort()) {
      running += investedPerDate.get(d) ?? 0;
      cumInvestedByDate.set(d, running);
    }
  }

  // Value series — nw_daily overrides mf_daily_reconstructed on any
  // overlapping date because nw_daily is authoritative for the
  // tracking era (mf_daily_reconstructed is a backfill that may
  // not perfectly match on the boundary day).
  const valueByDate = new Map<string, number>();
  for (const r of reconstructedRes.data ?? []) {
    if (r.date && r.mf_value_inr != null) {
      valueByDate.set(String(r.date), Number(r.mf_value_inr));
    }
  }
  for (const r of nwRes.data ?? []) {
    if (r.date && r.mf_value != null) {
      valueByDate.set(String(r.date), Number(r.mf_value));
    }
  }

  // Union of dates from both curves. Sort ascending for the chart.
  const allDates = new Set<string>([
    ...cumInvestedByDate.keys(),
    ...valueByDate.keys(),
  ]);
  const sortedDates = [...allDates].sort();

  // Forward-fill both curves so the chart has a value at every date
  // in the union — deposits stay flat between transactions, value
  // stays flat on non-trading days (weekends/holidays without a NAV
  // publication).
  //
  // IMPORTANT ASYMMETRY between invested and value forward-fill:
  //   • INVESTED starts at 0 by definition — before the first
  //     transaction, deposits ARE genuinely 0. Forward-fill from
  //     0 is truthful.
  //   • VALUE has no meaningful "0" baseline — before the first
  //     mf_daily_reconstructed / nw_daily row, we don't know what
  //     the portfolio was worth (or whether one even existed).
  //     Forward-filling from 0 would draw a curve that reads as
  //     "you had ₹15L invested and it was worth ₹0", which is
  //     nonsense and produces a giant fake "wall" the day real
  //     value data starts.
  //
  // Fix: emit `value: null` for dates BEFORE the first value
  // snapshot. Once we see any value data (hasSeenValue flips
  // true), we forward-fill from the last known snapshot. Recharts
  // renders null as a gap — the value area simply doesn't exist
  // until real data arrives, while the invested dashed line
  // continues showing the deposit history.
  const chart: StudioChartPoint[] = [];
  let lastInvested = 0;
  let lastValue = 0;
  let hasSeenValue = false;
  for (const d of sortedDates) {
    if (cumInvestedByDate.has(d)) lastInvested = cumInvestedByDate.get(d)!;
    if (valueByDate.has(d)) {
      lastValue = valueByDate.get(d)!;
      hasSeenValue = true;
    }
    chart.push({
      date: d,
      invested: lastInvested,
      value: hasSeenValue ? lastValue : null,
    });
  }

  // ── Order-cadence numbers (folded into stats on 2026-07-28) ──
  // Month-to-date rupees + order count AND lifetime order count,
  // all from non-test PURCHASE rows. Previously exposed as a
  // separate `progress` substructure driving the DailyProgressCard;
  // that component was removed and these fields moved into `stats`
  // when the six-tile unified grid was introduced.
  //
  // Single pass also tracks totalPurchaseInr (gross lifetime money-
  // in) and earliestPurchaseISO (for daysInvested) — both fuel the
  // derived per-tap / per-day metrics below.
  let monthInr = 0;
  let monthCount = 0;
  let totalOrders = 0;
  let totalPurchaseInr = 0;
  let earliestPurchaseISO: string | null = null;
  for (const e of productionLedger) {
    if (e.order_type !== "PURCHASE" || !e.amount_inr) continue;
    const d = effectiveDate(e);
    if (!d) continue;
    totalOrders += 1;
    totalPurchaseInr += e.amount_inr;
    if (earliestPurchaseISO == null || d < earliestPurchaseISO) {
      earliestPurchaseISO = d;
    }
    if (d.startsWith(thisMonth)) {
      monthInr += e.amount_inr;
      monthCount += 1;
    }
  }

  // ── Derived rates: AVG ORDER SIZE, DAILY EARNING, PROFIT/ORDER ─
  // All three share one numerator/denominator, computed once here so
  // client-side StatsRow just renders. Days since first purchase is
  // clamped to ≥1 — a same-day install would otherwise divide by
  // zero and render "∞" on the daily-earning tile.
  const daysInvested: number | null =
    earliestPurchaseISO != null
      ? Math.max(
          1,
          Math.floor(
            (Date.now() - new Date(`${earliestPurchaseISO}T00:00:00`).getTime()) /
              86_400_000
          )
        )
      : null;
  const unrealisedGain = value - invested;
  const avgOrderSize: number | null =
    totalOrders > 0 ? totalPurchaseInr / totalOrders : null;
  const dailyEarningRate: number | null =
    daysInvested != null && daysInvested > 0
      ? unrealisedGain / daysInvested
      : null;
  const profitPerOrder: number | null =
    totalOrders > 0 ? unrealisedGain / totalOrders : null;

  const isTestMode = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";

  return {
    chart,
    stats: {
      value,
      invested,
      oneDayInr,
      oneDayPct,
      monthInr,
      monthCount,
      totalOrders,
      totalPurchaseInr,
      daysInvested,
      avgOrderSize,
      dailyEarningRate,
      profitPerOrder,
      isTestMode,
    },
  };
}
