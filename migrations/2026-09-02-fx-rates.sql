-- ─── fx_rates ──────────────────────────────────────────────────────────────
-- Daily FX reference rates (USD→INR, and any future pair), captured from the
-- SAME source as the live International mark (open.er-api) so the per-fund
-- NAV-vs-FX growth chart can be built consistently with the card instead of
-- from Yahoo.
--
-- WHY A STORE (vs just calling Yahoo for history)
-- -----------------------------------------------
-- open.er-api's free tier only returns TODAY's spot — it has no historical
-- endpoint — so we can't backfill past days from it. Instead the intl NAV
-- refresh persists each day's open.er-api rate here (going forward). The chart
-- prefers these stored rates and falls back to Yahoo (USDINR=X) only for dates
-- that predate this store — a bootstrap tail that shrinks as rows accumulate.
--
-- One row per (pair, IST day); upsert so a same-day re-refresh overwrites.
create table if not exists fx_rates (
  pair       text        not null,                       -- e.g. 'USDINR' (INR per 1 USD)
  rate_date  date        not null,                        -- IST day the rate was captured
  rate       numeric     not null,                        -- quote units per 1 base
  source     text        not null default 'open.er-api',  -- provenance
  updated_at timestamptz not null default now(),
  primary key (pair, rate_date)
);

create index if not exists fx_rates_pair_date_idx on fx_rates (pair, rate_date);

-- Server-only (service_role bypasses RLS). No anon policy → not client-readable.
alter table fx_rates enable row level security;
