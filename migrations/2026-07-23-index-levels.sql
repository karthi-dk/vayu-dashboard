-- ─── index_levels ────────────────────────────────────────────────────────
--
-- One row per tracked market index, holding its current level plus three
-- "how far from the peak" reference points: all-time high, 52-week high,
-- and 3-month high. Powers the small "Index highs" widget on the Overview
-- page and the matching refresh card on /sync.
--
-- TRACKED INDICES (see lib/indexLevels/yahooClient.ts for the verified
-- Yahoo Finance ticker map — several of these took real trial-and-error
-- to pin down correctly, notably Nifty Next 50's oddly-named ^NSMIDCP
-- ticker and the fact that NIFTY_NEXT_50.NS is a dead/frozen symbol that
-- silently returns stale 2020 data):
--   N50        Nifty 50
--   NN50       Nifty Next 50
--   MID150     Nifty Midcap 150
--   SMALL250   Nifty Smallcap 250
--   NASDAQ100  Nasdaq 100
--   SP500      S&P 500
--
-- METHODOLOGY
-- -----------
-- All four levels (current, ATH, 52w-high, 3m-high) are derived from the
-- SAME daily-close series in one fetch per index, for internal
-- consistency (rather than mixing Yahoo's own precomputed
-- fiftyTwoWeekHigh — which may be intraday-high-based — with a
-- close-based ATH computed separately). See fetchIndexLevel() in
-- lib/indexLevels/yahooClient.ts for the exact window math.
--
-- Closing-price basis, not intraday high/low — the commonly-quoted
-- convention for "all-time high" in financial media (e.g. "Nifty closes
-- at a record high of X"), and the only basis Yahoo's chart endpoint
-- gives us without a second, heavier tick-level fetch.
--
-- REFRESH
-- -------
-- Manual button on /sync (RefreshIndexLevelsCard), calling
-- app/api/refresh-index-levels/route.ts. Each refresh re-fetches each
-- index's full daily history and overwrites the row — no incremental
-- append logic, no idempotency key needed; the whole point of this table
-- is "latest known values", not a time series.

create table if not exists index_levels (
  -- Short internal code — see the tracked-indices list above. Not the
  -- Yahoo ticker (that lives in code, not the DB) so a ticker fix never
  -- requires a migration.
  index_code text primary key,

  display_name text not null,

  -- 'INR' or 'USD' — lets the UI pick ₹ vs $ formatting per row without
  -- a lookup table.
  currency text not null,

  current_level numeric(14, 2) not null,
  -- Named as_of_date, not current_date — `current_date` is a reserved
  -- PostgreSQL keyword (the built-in CURRENT_DATE function), and using
  -- it unquoted as a column name throws a syntax error at CREATE TABLE
  -- time. Learned the hard way on first migration attempt.
  as_of_date date not null,

  ath_level numeric(14, 2) not null,
  ath_date date not null,

  high_52w_level numeric(14, 2) not null,
  high_52w_date date not null,

  high_3m_level numeric(14, 2) not null,
  high_3m_date date not null,

  updated_at timestamptz not null default now()
);

alter table index_levels enable row level security;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'index_levels';
--   -- expects: (index_levels, t)
--
--   select index_code, current_level, ath_level, high_52w_level, high_3m_level
--   from index_levels
--   order by index_code;
--   -- expects: 0 rows initially; 6 rows after the first /sync refresh click
