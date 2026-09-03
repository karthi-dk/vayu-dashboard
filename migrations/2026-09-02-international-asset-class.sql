-- International asset class + HDFC GIFT City (USD) fund
-- =====================================================
--
-- WHY
-- ---
-- Introduces "International" as a top-level asset class (peer of MF / NPS /
-- EPF) rather than a sub-slice of Mutual Funds. Two holdings live in it:
--   • ICICI_NASDAQ  — INR-denominated Nasdaq-100 index feeder (already in
--     fund_holdings; only its classification changes here).
--   • HDFC_INTL_DM  — HDFC International Developed Markets Equity Fund, a
--     USD-denominated GIFT City / IFSC fund-of-fund (new holding, seeded
--     below). NAV is published in USD; INR value = units × USD-NAV × USD→INR.
--
-- DESIGN
-- ------
-- We do NOT create a separate table. A single `asset_class` discriminator on
-- fund_holdings ('mf' | 'intl') keeps the entire existing pipeline (NAV
-- refresh for ICICI, recomputeNwDaily, portfolio queries, freshness) intact —
-- everything just groups by asset_class. USD-native funds carry extra nullable
-- columns (nav_usd / fx_usd_inr / …) so we can decompose INR return into NAV%
-- vs FX% and surface the redemption-short "exit today" value; INR-native funds
-- (ICICI, all MFs) leave them NULL.
--
-- Safe to re-run: all ADDs are IF NOT EXISTS, constraint swaps are DROP-then-
-- ADD, the seed INSERT is ON CONFLICT DO NOTHING, and the ICICI tag is
-- idempotent.

-- ── 1. fund_holdings: asset_class discriminator ──────────────────────────
ALTER TABLE fund_holdings
  ADD COLUMN IF NOT EXISTS asset_class text NOT NULL DEFAULT 'mf';

ALTER TABLE fund_holdings
  DROP CONSTRAINT IF EXISTS fund_holdings_asset_class_check;
ALTER TABLE fund_holdings
  ADD CONSTRAINT fund_holdings_asset_class_check
  CHECK (asset_class IN ('mf', 'intl'));

-- ── 2. fund_holdings: USD / FX columns (USD-native funds only) ───────────
-- All nullable — only HDFC_INTL_DM (and future USD funds) populate them.
-- nav (the existing INR column) always holds the INR-materialised NAV
-- (nav_usd × fx_usd_inr) so current_value_inr = units × nav keeps working
-- untouched for the aggregation layer.
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS invested_usd numeric;            -- USD cost basis (for NAV-vs-FX return split); NULL for INR funds
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS nav_usd numeric;              -- redemption_nav_long_term (gross), the mark
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS nav_usd_prev numeric;         -- prior USD NAV, for NAV-vs-FX 1D split
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS fx_usd_inr numeric;           -- USD→INR used for the current mark
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS fx_usd_inr_prev numeric;      -- prior USD→INR, for NAV-vs-FX 1D split
ALTER TABLE fund_holdings ADD COLUMN IF NOT EXISTS redeem_nav_short_usd numeric; -- redemption_nav_short_term (exit-today, embeds exit load)

-- ── 3. fund_holdings: admit 'hdfc-intl' as a nav_source ─────────────────
-- Extends the constraint last widened in 2026-07-23-nav-source-amfi.sql.
ALTER TABLE fund_holdings
  DROP CONSTRAINT IF EXISTS fund_holdings_nav_source_check;
ALTER TABLE fund_holdings
  ADD CONSTRAINT fund_holdings_nav_source_check
  CHECK (nav_source IS NULL OR nav_source IN ('groww', 'mfapi', 'amfi', 'hdfc-intl'));

-- ── 4. Reclassify ICICI Nasdaq-100 into International ────────────────────
-- Only the classification moves; its AMFI NAV refresh path is unchanged.
UPDATE fund_holdings SET asset_class = 'intl' WHERE fund_code = 'ICICI_NASDAQ';

-- ── 5. Seed the HDFC GIFT City holding ──────────────────────────────────
-- 50 units @ NFO USD 100 (27-Aug-2026), all-in INR debit ₹4,80,206.
-- Seed NAV = latest published redemption-long (31-Aug 99.3884) × a snapshot
-- USD→INR (95.00); the first refresh-hdfc-intl-nav run overwrites nav_usd /
-- fx_usd_inr / nav / current_value_inr with live values.
INSERT INTO fund_holdings (
  fund_code, fund_name, units, invested_inr, invested_usd,
  cap_type, asset_class, currency,
  nav_usd, fx_usd_inr, redeem_nav_short_usd,
  nav, current_value_inr, nav_date, nav_source
) VALUES (
  'HDFC_INTL_DM',
  'HDFC Intl Developed Markets Equity Fund Direct',
  50, 480206, 5000,
  'intl', 'intl', 'USD',
  99.3884, 95.00, 99.3884,
  99.3884 * 95.00, 50 * 99.3884 * 95.00, '2026-08-31', 'hdfc-intl'
)
ON CONFLICT (fund_code) DO NOTHING;

-- ── 6. nw_daily: International slice columns ─────────────────────────────
-- Parallel to mf_value / nps_value / epf_estimate. recomputeNwDaily populates
-- them going forward; the backfill script fills history. mf_value now EXCLUDES
-- asset_class='intl'; total_nw = mf_value + nps_value + epf_estimate + intl_value.
ALTER TABLE nw_daily ADD COLUMN IF NOT EXISTS intl_value numeric;
ALTER TABLE nw_daily ADD COLUMN IF NOT EXISTS intl_invested numeric;
ALTER TABLE nw_daily ADD COLUMN IF NOT EXISTS intl_1d_change_inr numeric;
ALTER TABLE nw_daily ADD COLUMN IF NOT EXISTS intl_1d_change_pct numeric;
ALTER TABLE nw_daily ADD COLUMN IF NOT EXISTS intl_gain_pct numeric;
