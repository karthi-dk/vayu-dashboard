-- ─── MF Daily Reconstruction ──────────────────────────────────────────────
--
-- Three tables that together let the Overview page's "MF Growth" chart
-- render the full Jan → Jul story instead of stopping at Jul 12 (which
-- is when `nw_daily` snapshotting started).
--
-- WHY THREE TABLES AND NOT AN nw_daily EXTENSION
-- ──────────────────────────────────────────────
-- `nw_daily` is our observed-snapshot table: one row per calendar day
-- captured from Dhan + NPS + EPF at that day's actual state. Blending
-- reconstructed rows into it would (a) force previously-NOT-NULL columns
-- like `total_nw` to become nullable, breaking every downstream consumer,
-- and (b) blur the semantic — "did I actually see this data on Apr 15
-- or did I reconstruct it later?".
--
-- These new tables sit alongside `nw_daily`. `getOverviewData()` unions
-- them at read time, preferring `nw_daily` for overlapping dates
-- (observed always beats reconstructed).
--
-- SAFETY / ROLLBACK STORY
-- ───────────────────────
-- All three tables are additive. `TRUNCATE` any one of them (or `DROP
-- TABLE` the lot) and the app degrades gracefully — the union helper
-- detects missing tables via 42P01/PGRST205 and falls back to
-- `nw_daily`-only behaviour. Same graceful pattern used by
-- mf_contributions and mf_transactions.

-- ─── 1. mf_nav_history ────────────────────────────────────────────────────
--
-- Raw daily NAV cache pulled from mfapi.in. One row per (fund, date).
-- Immutable once fetched — AMFI NAVs for historical dates never change.
--
-- Populated by scripts/backfill-mf-reconstruction.mjs on initial setup.
-- Safe to TRUNCATE + re-run the script if you want fresh data.
create table if not exists mf_nav_history (
  -- Our canonical fund_code (matches fund_holdings.fund_code). Not FK'd
  -- so a fund_holdings reseed doesn't cascade-delete NAV history.
  fund_code text not null,

  -- AMFI scheme code used for the fetch. Stored for audit / debugging
  -- (so you can trace "which mfapi.in URL produced this row?").
  scheme_code text not null,

  -- Trading day. NULL not allowed — we only insert rows we actually
  -- got a NAV for. Weekends / holidays are handled by carry-forward
  -- in the reconstruction step, not by inserting synthetic rows here.
  nav_date date not null,

  -- 4-decimal NAV (matches AMFI's published precision).
  nav numeric(14, 4) not null,

  fetched_at timestamptz not null default now(),

  primary key (fund_code, nav_date)
);

-- Range scans by date (reconstruction step iterates dates in order),
-- and per-fund fetches for the debug modal.
create index if not exists mf_nav_history_nav_date_idx
  on mf_nav_history (nav_date);
create index if not exists mf_nav_history_fund_code_idx
  on mf_nav_history (fund_code);

alter table mf_nav_history enable row level security;

-- ─── 2. mf_daily_reconstructed ────────────────────────────────────────────
--
-- Per-date rollup: total MF value + cost basis, computed from
-- `mf_transactions` unit balances × `mf_nav_history` NAVs. Same MF-side
-- columns as `nw_daily` so union'ing the two is a plain "prefer left"
-- merge in `getOverviewData`.
--
-- Volume: ~200 rows (Jan 7 through Jul 11 approximately). Recompute is
-- cheap — a TRUNCATE + reinsert takes seconds.
create table if not exists mf_daily_reconstructed (
  date date primary key,

  -- Total MF market value on this date. Σ(units held × nav that day).
  mf_value_inr numeric(14, 2) not null,

  -- Cumulative net deposits (purchases − redemptions) as of this date.
  -- Same definition as the ledger-based mf_invested elsewhere; kept in
  -- lockstep so mf_gain_pct is meaningful.
  mf_invested_inr numeric(14, 2) not null,

  -- Equity vs Debt split — computed by classifying each fund via its
  -- fund_holdings.cap_type on the reconstruction pass. NULL if we
  -- couldn't classify a fund on this date (should never happen with
  -- our current 10-fund portfolio).
  mf_equity_inr numeric(14, 2),
  mf_debt_inr numeric(14, 2),

  -- Same shape as nw_daily so downstream chart / attribution code is
  -- schema-compatible without a translation layer.
  mf_1d_change_inr numeric(14, 2),
  mf_1d_change_pct numeric(8, 4),
  mf_gain_pct numeric(8, 4),

  -- Diagnostic: how many funds contributed to this row. Handy for
  -- spotting "why did April spike?" — a jump from 5 to 6 funds tells
  -- the story better than raw value alone.
  fund_count integer not null,

  computed_at timestamptz not null default now()
);

create index if not exists mf_daily_reconstructed_date_idx
  on mf_daily_reconstructed (date);

alter table mf_daily_reconstructed enable row level security;

-- ─── 3. mf_daily_reconstructed_by_fund ────────────────────────────────────
--
-- Per-(date, fund) breakdown. Optional debugging aid — the aggregate
-- table above is sufficient for the chart, but this lets you answer
-- questions like "which fund drove the Apr 15 spike?" via SQL.
--
-- Volume: ~200 dates × 10 funds ≈ 2000 rows. Rebuilt from scratch on
-- every reconstruction pass.
create table if not exists mf_daily_reconstructed_by_fund (
  date date not null,
  fund_code text not null,

  -- Cumulative units held as of this date. Signed cumsum of
  -- mf_transactions.units for (fund_code, tx_date ≤ date).
  units numeric(18, 4) not null,

  -- NAV used on this date. Carried forward from the most recent
  -- weekday if the exact date isn't in mf_nav_history (typical for
  -- weekends and public holidays where AMFI doesn't publish).
  nav numeric(14, 4) not null,

  -- units × nav. Denormalised for direct read; recomputable from the
  -- other two.
  value_inr numeric(14, 2) not null,

  -- Cumulative cost basis for this fund on this date. Purchase-only
  -- SIP sums; not adjusted for FIFO redemptions. Useful for a rough
  -- per-fund gain calc without a full lot-level tracker.
  cost_basis_inr numeric(14, 2) not null,

  primary key (date, fund_code)
);

create index if not exists mf_daily_reconstructed_by_fund_date_idx
  on mf_daily_reconstructed_by_fund (date);
create index if not exists mf_daily_reconstructed_by_fund_fund_code_idx
  on mf_daily_reconstructed_by_fund (fund_code);

alter table mf_daily_reconstructed_by_fund enable row level security;

-- ─── Verification ─────────────────────────────────────────────────────────
--
-- Confirm all three tables + RLS:
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname in (
--     'mf_nav_history',
--     'mf_daily_reconstructed',
--     'mf_daily_reconstructed_by_fund'
--   );
--   -- expects: 3 rows, all relrowsecurity = t
--
--   select
--     (select count(*) from mf_nav_history) as nav_rows,
--     (select count(*) from mf_daily_reconstructed) as agg_rows,
--     (select count(*) from mf_daily_reconstructed_by_fund) as fund_rows;
--   -- expects: (0, 0, 0) initially
