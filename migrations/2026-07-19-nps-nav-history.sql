-- ─── nps_nav_history ─────────────────────────────────────────────────────
--
-- Daily NAV cache for the three Kotak Tier I POP schemes (E, C, G) that
-- the user is invested in. Analogous to `mf_nav_history` on the MF side.
--
-- Populated in two phases:
--   1. One-shot backfill from npsnav.in's /api/historical/{code} endpoint
--      via scripts/backfill-nps-nav-history.ts. Covers Kotak's fund
--      inception (Aug 2009 for E) through today — the historical API
--      returns the entire published series in a single response.
--   2. Incremental keep-alive: /api/refresh-nps-nav (the same handler
--      that updates nps_state.scheme_*_nav from Kotak/npsnav.in daily)
--      inserts today's NAV into this table on every successful refresh
--      so the series stays fresh going forward without a re-backfill.
--
-- WHY A DEDICATED TABLE VS EXTENDING nav_history
-- ──────────────────────────────────────────────
-- The existing `nav_history` (from schema.sql) is keyed on `fund_code`
-- for MF AMFI scheme codes. NPS scheme codes come from a different
-- registry (npsnav.in's SM* codes → Kotak PFE/PFC/PFG), so mixing the
-- two would blur the type of `fund_code` and force downstream queries
-- to disambiguate. Keeping them separate matches the existing
-- separation on the state side (fund_holdings vs nps_state).
--
-- WHY A DEDICATED TABLE VS DERIVING FROM nps_transactions
-- ───────────────────────────────────────────────────────
-- `nps_transactions.nav` gives us NAVs on ~45 unique dates over 840
-- calendar days (transactions happen ~weekly, so ~5% coverage). To
-- render a smooth daily value curve — required for parity with the
-- MF Value-vs-Invested chart — we need NAVs on every trading day.
-- The historical endpoint fills that gap.
--
-- USE BY DOWNSTREAM CODE
-- ──────────────────────
-- getOverviewData() joins this table against a per-day units cumsum
-- from nps_transactions to reconstruct daily NPS values back to first
-- contribution date. See buildNpsDailyHistory().

create table if not exists nps_nav_history (
  -- npsnav.in scheme code — SM005001 (E), SM005002 (C), SM005003 (G).
  -- Retained rather than derived from `scheme` so that when the daily
  -- refresh writes here, we can trace which upstream code produced
  -- the value (helpful when npsnav.in re-aliases codes; see the
  -- historical note in app/api/refresh-nps-nav/route.ts about the
  -- POP vs DIRECT confusion from Jul 17, 2026).
  scheme_code text not null,

  -- Denormalised scheme letter for convenient joins against
  -- nps_transactions.scheme without a lookup table. UNIQUE'd via the
  -- PK below (scheme_code is the true identity — scheme_code varies
  -- 1:1 with scheme letter for this user's holdings).
  scheme text not null,

  nav_date date not null,

  -- 4-decimal NAV — matches Kotak's published precision (they publish
  -- 4dp) and CRA's SOT rows.
  nav numeric(14, 4) not null,

  -- Provenance for post-hoc debugging:
  --   'npsnav.in'    — backfilled from /api/historical (bulk one-shot)
  --   'kotak'        — daily refresh path picked Kotak (primary)
  --   'npsnav.in-daily' — daily refresh path fell back to npsnav.in
  --   'cra_sot'      — seeded from nps_transactions.nav during backfill
  --                    to guarantee coverage on tx dates (belt-and-
  --                    braces against npsnav.in gaps)
  source text not null,

  fetched_at timestamptz not null default now(),

  primary key (scheme_code, nav_date)
);

-- Range scans by date (charts iterate dates in order); per-scheme
-- filter for the E/C/G reconstruction fan-out.
create index if not exists nps_nav_history_nav_date_idx
  on nps_nav_history (nav_date);
create index if not exists nps_nav_history_scheme_idx
  on nps_nav_history (scheme);
create index if not exists nps_nav_history_scheme_code_idx
  on nps_nav_history (scheme_code);

alter table nps_nav_history enable row level security;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'nps_nav_history';
--   -- expects: (nps_nav_history, t)
--
--   select count(*) from nps_nav_history;
--   -- expects: 0 initially; after backfill: ~4000 rows per scheme
--                (Aug 2009 → today, trading days only, × 3 schemes)
