-- ==========================================================================
-- mf_contributions — one row per MF purchase/redemption order
-- ==========================================================================
--
-- Backfills every historical MF transaction from Groww's order-history
-- API (POST /api/sync-mf-contributions ingests both the LIST-endpoint
-- shape and the DETAIL-endpoint shape). Also usable for other brokers
-- later — the `source` column distinguishes provenance.
--
-- Why a separate table (vs. shoving it into fund_holdings)?
--   • fund_holdings is a SNAPSHOT (current units, current NAV, current
--     value). It answers "what do I own right now?"
--   • mf_contributions is an EVENT LOG (each buy / sell). It answers
--     "what did I put in, when, at what NAV?"
-- Both are needed. Snapshot for the Overview headline; event log for
-- XIRR, cost-basis reconciliation, holding-period display, etc.
--
-- Design notes
-- ------------
-- • Primary key = source-prefixed order_id, not just order_id.
--   That way when a second broker/source lands (Zerodha Coin, MFU,
--   etc.), an order-id collision is impossible.
--
-- • fund_code is NULLABLE. If Groww returns a scheme we don't have in
--   lib/fundIsin.ts (e.g., a NEW fund we haven't onboarded yet), we
--   still want to ingest the row — the ingestion route just leaves
--   fund_code null and surfaces the count in the response.
--
-- • raw jsonb column stores the entire order object. Cheap insurance
--   for schema evolution: if Groww adds a field we care about later,
--   we can backfill it from raw without re-scraping.
--
-- • paisa_amount vs. amount_inr: Groww returns both. `amount` (paise)
--   is what actually left your bank; `orderVal` (rupees) is what you
--   asked for. They can differ by a few paise due to their internal
--   rounding. Store both so XIRR uses the true outflow.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS mf_contributions (
  -- Identity ---------------------------------------------------------
  order_id            TEXT PRIMARY KEY,        -- e.g. G260717021658TVS0ISJYA
  source              TEXT NOT NULL DEFAULT 'groww',

  -- Scheme identification -------------------------------------------
  scheme_code         TEXT,                    -- AMFI numeric code, e.g. "143341"
  scheme_isin         TEXT,                    -- MF unit ISIN, e.g. INF789FC12T1
  scheme_name         TEXT,
  amc_code            TEXT,
  scheme_type         TEXT,                    -- "Growth" / "Dividend"
  sub_category        TEXT,                    -- Broker-provided ("Large Cap", "Mid Cap"...)

  -- Our internal mapping --------------------------------------------
  fund_code           TEXT,                    -- Resolved via ISIN/scheme_code, nullable

  -- Order metadata ---------------------------------------------------
  order_type          TEXT,                    -- PURCHASE / REDEMPTION / SWITCH_IN / SWITCH_OUT
  order_status        TEXT,                    -- COMPLETED / PENDING / FAILED
  order_description   TEXT,                    -- "One-time" / "SIP"
  buy_sell            TEXT,                    -- P / R / SI / SO
  exchange            TEXT,                    -- BSE / NSE
  bse_order_type      TEXT,                    -- NRM / etc
  is_first_order      BOOLEAN,

  -- Money & units ---------------------------------------------------
  amount_inr          NUMERIC(14, 2),          -- from orderVal (₹)
  paisa_amount        BIGINT,                  -- from `amount` (paise) — audit
  units               NUMERIC(20, 6),
  nav                 NUMERIC(12, 4),          -- computed: amount_inr / units

  -- Dates ------------------------------------------------------------
  order_date          DATE NOT NULL,
  nav_date            DATE,
  completion_date     DATE,                    -- when units credited
  placed_at           TIMESTAMPTZ,             -- exact click time
  payment_date        TIMESTAMPTZ,

  -- Detail-endpoint-only fields (nullable) --------------------------
  folio_number        TEXT,
  payment_source      TEXT,                    -- e.g. "HDFC BANK XX1751"

  -- Full payload for future field additions --------------------------
  raw                 JSONB,

  -- Bookkeeping ------------------------------------------------------
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-fund history (portfolio page fund drill-down, contributions log)
CREATE INDEX IF NOT EXISTS mf_contributions_fund_date_idx
  ON mf_contributions (fund_code, order_date DESC)
  WHERE fund_code IS NOT NULL;

-- Global recent-orders list (Overview "recent activity" strip)
CREATE INDEX IF NOT EXISTS mf_contributions_order_date_idx
  ON mf_contributions (order_date DESC);

-- Lookups by ISIN — cheap because most rows have an ISIN and the
-- table stays small (a few thousand rows lifetime).
CREATE INDEX IF NOT EXISTS mf_contributions_isin_idx
  ON mf_contributions (scheme_isin)
  WHERE scheme_isin IS NOT NULL;

-- ==========================================================================
-- Row Level Security
-- ==========================================================================
-- Same posture as every other table in this project: RLS on, zero
-- policies → anon gets deny-all, service_role bypasses. All access
-- flows through Next.js API routes.
-- ==========================================================================

ALTER TABLE mf_contributions ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- Verify
-- ==========================================================================
-- After running this migration, run these to confirm:
--
--   -- Table exists with expected columns
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'mf_contributions'
--   ORDER BY ordinal_position;
--
--   -- RLS on, zero policies (deny-all)
--   SELECT rowsecurity, (
--     SELECT COUNT(*) FROM pg_policies
--     WHERE schemaname='public' AND tablename='mf_contributions'
--   ) AS policy_count
--   FROM pg_tables
--   WHERE schemaname='public' AND tablename='mf_contributions';
-- ==========================================================================
