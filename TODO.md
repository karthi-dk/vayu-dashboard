# TODO

Durable backlog — survives across chat sessions, unlike the in-session
TodoWrite list. Add new items with enough context that a future session
(me or another agent) can pick them up cold without re-deriving the
reasoning from scratch.

---

## Commodity (Gold now, Silver later) — new asset class, PLANNED for Sep 2026

User is buying a small gold position this month (**max ~₹2 L**, an ETF or a
fund) and may add silver later. Decision (2026-09-02): model it as **one
general asset class, not `'gold'`** — so silver / future commodities slot in
with no schema churn.

**Design decisions (locked):**
- `fund_holdings.asset_class = 'commodity'` (broadest — covers metals *and*
  any future commodity). Display label in UI = "Precious Metals" (or
  "Commodities"). DB value ≠ display label, so we can relabel freely.
- Gold and silver stay **distinct at the holding level** (one `fund_holdings`
  row each, own NAV) but roll up into **one "Commodities" band** in the
  composition charts — you don't want a tiny band per metal. The stat card can
  sub-split gold vs silver like the NPS card splits E/C/G
  (`computeNpsSchemeBreakdown` is the template).
- Commodity is neither equity nor debt → **exclude from the Equity/Debt
  split**; it **counts as liquid** (ETF/fund redeemable) in the Liquidity card.

**Data source (depends on ETF vs fund — but both are easy):**
- A gold/silver **fund** (e.g. Nippon India / HDFC / SBI Gold Savings Fund) or
  an **ETF** (GOLDBEES etc.) has a daily **AMFI NAV**, so it rides the existing
  MF NAV pipeline (`refresh-mf-nav` / mfapi.in) with **zero new plumbing** —
  just tag the holding and give it an AMFI scheme code.
- Only if the user wants the **live NSE market price** of an ETF (vs end-of-day
  NAV) do we add a Yahoo ticker path (`GOLDBEES.NS` etc.), like the intl FX.
  Default = NAV (simplest).

**Implementation = mirror the International asset class** (shipped 2026-09-02;
see `/memories/repo/build-notes.md` "INTERNATIONAL ASSET CLASS SHIPPED" +
"INTL SLICE-CONSUMER SWEEP" for the exact file list). Steps:
1. Migration: allow `asset_class='commodity'`; add `nw_daily.commodity_value /
   commodity_invested / commodity_1d_change_inr / _pct / _gain_pct` (once).
2. `lib/recomputeNwDaily.ts`: split out `commodityRows`; `total_nw = mf + nps +
   epf + intl + commodity`; derive commodity 1D from Σ one_day_change_inr.
3. Slice-consumer sweep (the STANDING LESSON — grep `mf_value|nps_value|
   epf_estimate|intl_value` rollups + `{mf,nps,epf,intl}` slice UI):
   NWCompositionChart, WealthCompositionCard, LiquidityCard (liquid),
   EquityDebtCard (EXCLUDE), HeadlineNW 1D, a Commodities StatCard,
   RefreshAllButton, `recompute-today-nw.mjs`, `buildNwHistory`
   (`lib/nwReconstruct.ts`), and getOverviewData/getPortfolioData.
4. Seed the holding(s) + (if fund/ETF-by-NAV) confirm the AMFI code resolves on
   mfapi.

**To execute, still need from user (when they buy):**
1. Exact instrument(s) — name + **AMFI scheme code** (fund/ETF NAV) or **NSE
   ticker** (ETF live price).
2. ETF or fund (confirms data source).
3. Buy date + amount / units (to seed `fund_holdings`).

Recommended timing: wait until the actual purchase, then do it in one clean
pass (the amount is small and the pattern is proven, so it's low-effort).

---

## Asset-class reorganization — allocation-first 5 buckets (FUTURE)

Requested 2026-09-03. User wants the top-level asset classes regrouped by
ASSET TYPE / risk (not product wrapper) for a clearer allocation /
diversification view:

  1. Indian MF     — Indian EQUITY MF only
  2. International  — HDFC DM + ICICI Nasdaq (asset_class='intl')
  3. Gold          — asset_class='commodity' (see Commodity section above)
  4. Fixed         — EPF + debt / arbitrage / conservative-hybrid MF
  5. NPS           — its own bucket; E/C/G NOT counted in any other bucket (DECIDED)

**GOOD NEWS — the data already exists; this is a ROLLUP REMAP, not a schema
rewrite** (except Gold's 'commodity' class, already planned). `nw_daily`
already splits `mf_equity_inr` / `mf_debt_inr` (recomputeNwDaily: cap_type
='debt' → debt, else equity), plus `epf_estimate`, `intl_value`, `nps_value`
(and `commodity_value` once Gold lands). So the buckets are just:
  - Indian MF (equity) = `mf_equity_inr`
  - Fixed              = `mf_debt_inr + epf_estimate`
  - International       = `intl_value`
  - Gold               = `commodity_value`
  - NPS                = `nps_value`

Current holdings map cleanly with NO new tagging: HDFC_STD (Short Term Debt)
and PPFAS_CH (Conservative Hybrid) are BOTH already `cap_type='debt'` → Fixed;
the 7 equity funds (PPFAS_FC, UTI_N50, UTI_NN50, HDFC_FC, NIPPON_MID, EDEL_MID,
HDFC_SC) → Indian MF. If an arbitrage fund is added later, tag it
`cap_type='debt'` (or add a distinct sleeve tag) so it routes to Fixed.
Live snapshot 2026-09-03: Indian MF ~₹39.3L · International ~₹5.8L · Fixed
~₹21.3L (EPF 19.2 + debt MF 2.05) · NPS ~₹6.1L.

NPS DECISION — **DECIDED 2026-09-03: option (a)**. NPS stays its OWN bucket; its
E/C/G is fully self-contained and **NOT counted in any other bucket** (Indian MF
stays equity ex-NPS; Fixed stays EPF + debt-MF ex-NPS). No look-through split.
So the scheme is a deliberate hybrid: NPS is the one product-wrapper bucket, the
other four are asset-type. (Rejected (b), the E→equity / C+G→Fixed look-through —
keep NPS opaque as a single illiquid retirement bucket.)

SCOPE: mostly presentation — a shared bucket-mapping consumed by the
allocation donut, NW Composition, Wealth Composition, Equity/Debt, Liquidity
and the stat-card row. Same "slice-consumer sweep" discipline as the
International class (grep the `{mf,nps,epf,intl}` rollups + slice UI). No
migration beyond Gold's `commodity`. Best done together with / right after the
Gold build.

---

## NPS: remove from UI + net-worth (keep growing hidden) — PARKED

Requested 2026-08-26, then parked (“I'll decide later”). User wants NPS out
of all main UI + net-worth math because it's illiquid — let it keep syncing/
growing but shown only on a hidden page. Discovery is done; **three decisions
are still open** before implementing:

1. **NW history** — recompute stored `nw_daily.total_nw = mf + epf` for every
   past day (clean, permanent), OR subtract NPS only at read/display time.
2. **Hidden home** — a hidden `/nps` page (not in nav, URL-reachable), OR
   DB-only (no UI at all).
3. **Syncing/controls** — keep NPS auto-syncing and move its controls (NAV
   refresh, CAS/CRA paste, unit/contrib edits) to `/nps`, OR leave them where
   they are, OR freeze NPS.

Key facts from the touch-point map: `total_nw` is **stored** in `nw_daily`
(via `recomputeNwDaily`), the NW charts read **both** stored `nw_daily` AND
reconstructed `nwHistory` (`buildNwHistory` sums mf+nps+epf), and **no**
standalone NPS page exists yet. Draft approach (if all-recommended): keep the
`nps_*` tables + sync routes + cron; `recomputeNwDaily` → `mf + epf`; backfill
historical `total_nw`; `buildNwHistory` total = mf+epf (retain `nps_value`
column for `/nps`); strip NPS from Overview cards/charts + headline 1D; add a
hidden `app/nps/page.tsx`. NPS is woven into: Overview NPS card,
`NpsGrowthBreakdown`, Wealth-Composition donut, Equity/Debt split, Liquidity
card, NW trend + composition charts, headline 1D, Settings/Sync/Credits.

---

## International / foreign look-through — deferred polish

Shipped 2026-09-02 (International asset class + Foreign look-through /
Country / Foreign-sector cards). Two nice-to-haves were explicitly
deferred:

1. **Data-freshness “as of” on the foreign look-through** — ICICI’s
   underlying holdings come from a Dhan snapshot that can lag (e.g.
   “31 May”); surface the as-of date so a stale look-through is visible.
   HDFC DM’s iShares paste already carries whatever day you pasted.
2. **Lazy-load per-country / per-sector holdings** — the foreign cards
   cap each bucket to its top 100 by weight to keep the RSC payload
   small; if the foreign book grows, fetch the long tail on drill-in
   instead of shipping it all with the page.

---

## MF: XIRR + entry-price analysis (per fund + total portfolio)

Requested 2026-07-23, following the NPS XIRR build (`lib/xirr.ts` +
`computeNpsXirr` in `lib/queries.ts`, badge on `NpsGrowthBreakdown`).
Three related asks, do them together since they share data:

> **STATUS (2026-07-31):** items 2 + 3 SHIPPED as the "My avg NAV /
> Index NAV / vs Index" columns on the Portfolio Fund-holdings table
> (`attachEntryPriceAnalysis` in `lib/queries.ts` +
> `components/portfolio/HoldingsTable.tsx`). Item 1 (MF XIRR) is still
> open.

### 1. MF XIRR — per fund AND total MF portfolio

Same `computeXirr()` solver in `lib/xirr.ts` — no new math needed, just a
new cash-flow builder analogous to `computeNpsXirr`, fed from
`mf_transactions` instead of `nps_transactions`.

**The one thing to get right — mirrors the NPS switch_in/switch_out
nuance exactly:**

| Scope | `switch_in` / `switch_out` |
|---|---|
| **Per-fund XIRR** | ✅ INCLUDE — a switch_in to Fund X is real money entering Fund X from elsewhere, even though it's not new money into the portfolio. Treat like a purchase/redemption for that fund's own cash-flow list. |
| **Total portfolio XIRR** | ❌ EXCLUDE — money moving between funds you already hold nets to zero at the portfolio level. Same logic as NPS's scheme_in/scheme_out exclusion at the Tier I aggregate. |

Also check the exact `tx_type` vocabulary in `mf_transactions`
(`purchase`, `sip_registration`, `sip_cancellation`, `redemption`,
`switch_in`, `switch_out`, possibly more — re-read
`migrations/2026-07-18-mf-transactions.sql`'s tx_type comment before
writing the filter). `sip_registration`/`sip_cancellation` carry
`amount = 0` — harmless if included, but cleaner to exclude explicitly.

Terminal flow: `fund_holdings.current_value_inr` per fund (for per-fund
XIRR) or the summed total (for portfolio XIRR) — reuse whatever `nw_daily`
/ `fund_holdings` field the rest of the app already treats as ground
truth for "current value," same principle as NPS reusing
`nw_daily.nps_value` rather than inventing a second "current value"
definition.

**Trust calibration reminder (from the 2026-07-23 conversation) — do not
skip this when building the UI:** XIRR is only a *reliable* signal past
~3 years of span; 1 year is an improvement over 6 months but still not
"accurate" in the trustworthy sense. Show the badge whenever it's
computable (per computeXirr's contract), same as NPS — but if there's
ever a "how good is this fund" framing in copy, don't imply a <3yr number
is decision-grade.

### 2. My average entry NAV (per fund) — DONE 2026-07-31

Cost basis per unit, computed from MY OWN transactions:

```
avgEntryNav = Σ(amount paid on purchase/sip rows) / Σ(units acquired on those rows)
```

Equivalent to Groww/INDmoney's own `averageNav` / `average_price` field
(seen in the INDmoney portfolio JSON earlier this session — e.g.
`"averageNav": 34.8529` for HDFC Short Term Debt). Computing it ourselves
from `mf_transactions` is worth doing anyway because:
- it's fully transparent (verifiable against the raw ledger)
- it works even for funds/folios external platforms don't track live
  (e.g. only visible via CAS)
- it's a natural sanity-check cross-reference against Groww/INDmoney's
  own number — if they diverge meaningfully, that's a data-quality signal
  worth investigating (missing transactions, wrong sign, etc.)

Exclude `redemption` from the numerator/denominator of the *entry* price
(redemptions are an exit price question, not an entry price question) —
unless there's a reason to track "average exit NAV" too, which wasn't
asked for here but is the natural symmetric extension if it comes up.

### 3. How close is my average entry NAV to the fund's own average NAV over the same period? — DONE 2026-07-31

This is the one that actually *measures* whether the "flood with 280
entries/year" SIP strategy discussed in this session's conversation
worked — i.e., did spreading purchases out reduce personal timing luck,
or did the fund's own average NAV over that window come out meaningfully
different from what I actually paid?

```
fundAvgNav(fundCode, startDate, endDate) =
  mean(mf_nav_history.nav WHERE fund_code = X AND date BETWEEN [startDate, endDate])
```

- `startDate`/`endDate` = first and last `mf_transactions` date for that
  fund (i.e., the exact window I was actually buying in — not some
  arbitrary calendar range).
- Compare `avgEntryNav` (item 2) against `fundAvgNav` for the same
  window. Report as a % difference — negative means I bought *below*
  the period average (good), positive means *above* (bad).
- Simple arithmetic mean of daily NAV is the natural starting point;
  a units-weighted or day-weighted average is a possible refinement if
  the simple mean turns out to disagree meaningfully with intuition, but
  don't over-build this on the first pass — simple mean first, iterate
  only if it's visibly wrong on inspection.

`mf_nav_history` already exists (`migrations/2026-07-18-mf-daily-
reconstruction.sql`, keyed by `fund_code` + `date` + `nav`) — no backfill
needed to start this, same as items 1 and 2.

### Suggested surfacing

- Per-fund: natural home is a per-fund drill-down (the existing
  `FundDetailsModal` pattern in `components/sync/FundDetailsModal.tsx`,
  or wherever fund-level detail already renders) — add avgEntryNav,
  fundAvgNav-over-window, and the % delta as a small stat block, plus
  per-fund XIRR if there's room.
- Portfolio-level: XIRR badge on `MFGrowthBreakdown`'s header, matching
  the `NpsGrowthBreakdown` pattern exactly (same badge styling, same
  "not range-reactive — computed once over full ledger" reasoning).

### Files likely touched

- `lib/queries.ts` — new `computeMfXirr()` (per-fund + portfolio
  variants), `computeAvgEntryNav()`, `computeFundAvgNavOverWindow()`.
  Reuses `computeXirr` from `lib/xirr.ts` — no changes needed there.
- `components/overview/MFGrowthBreakdown.tsx` — XIRR badge (mirror
  `NpsGrowthBreakdown`'s header change from 2026-07-23).
- Per-fund modal (TBD which one) — avgEntryNav / fundAvgNav / delta stat
  block.

---

## Studio: content-creation enhancements (deferred)

Raised 2026-07-30. Two ideas were discussed but explicitly parked for
later — no code shipped for either yet.

### 2. Cinema calibration timer / slow-motion toggle

**Problem it solves:** the reveal waterfall runs on a 4s budget
(`STUDIO_TIMING` in `components/studio/RevealDashboard.tsx`). Screen
recorders capture it fine at 60fps, but there's no *editing* headroom:
you can't cleanly slow a fast clip in post (frame interpolation ghosts),
and there's no breathing room for a voiceover walking through the chart
draw / roll-up / verdict beats. Slowing the source is the fix.

**Shape of the feature:** a global speed multiplier (e.g. 1x / 0.5x /
0.25x) that scales the whole ceremony in lockstep so audio + visuals stay
sample-aligned:
- Multiply every `STUDIO_TIMING` value (or wrap reads in a
  `scale(ms)` helper) — `CHART_DURATION`, `PILL_*`, `STATS_*`,
  `ROLLUP_SOUND_BEGIN`, `TOTAL_ORDERS_SETTLE`, `VERDICT_BEGIN`. These
  already flow to children via props, so one dial should cascade.
- Lottie: call `setSpeed()` in `components/studio/CelebrationOverlay.tsx`
  with the same multiplier (it currently derives `LOTTIE_SPEED` from a
  fixed target duration — factor the multiplier in there).
- Audio: the synths in `lib/studio/sounds.ts` are scheduled against the
  same clock; verify the rollup/ding/verdict still line up when slowed
  (they may need their own scheduled offsets scaled, not just the visual
  timings). This is the fiddly part — the audio is tuned to land on
  specific tile-settle frames.
- Surface the control via a `?speed=0.5` URL param so it's scriptable
  and doesn't add on-camera chrome.

**Gotcha:** `prefers-reduced-motion` users already get the static Skip
path via `RollUpNumber` — the slow-mo dial should only affect the
animated (Submit / Replay) path.

### 4. Same-frame theme switching (hotkeys + mobile gesture)

**Problem it solves:** to record a seamless "theme morph" cut, the
creator needs to swap Classic → Clay → Glass → Soft → Skeuo without
navigating an on-screen menu (which breaks the shot).

**Shape of the feature:**
- Desktop / device-mode capture: bind number keys `1–5` to the
  `STUDIO_THEMES` entries in `lib/studio/themes.ts` and `R` to reset the
  reveal from t=0 (bump the `replayCount` remount key in
  `RevealDashboard.tsx`). Keydown listener on `window`, scoped to
  `/studio*`, ignored when an input/select is focused.
- Physical mobile (no keyboard): a discreet gesture, e.g. triple-tap the
  "Studio" title (or a 2-finger tap anywhere) cycles to the next theme.
  Keep it invisible so it never shows in a recording — this is the
  mobile-first counterpart to the hotkeys since the Studio screen is
  primarily a phone surface.
- Navigation currently uses `<Link>` (route change per theme). Hotkey /
  gesture handlers can `router.push()` the next theme's href instead.
