-- ─── nps_transactions ────────────────────────────────────────────────────
--
-- Lot-level NPS transaction ledger for Tier I schemes (E/C/G/A), fed by
-- pasting Protean CRA "Statement of Transactions" (SOT) HTML pages into
-- the Sync page. Analogous to `mf_transactions` on the MF side.
--
-- Each row is one line from the CRA transaction table for one scheme on
-- one date. Regular monthly contributions produce 3 rows (E, C, G) per
-- credit event; quarterly CRA billing charges produce another 3 rows
-- (negative amount) per bill event.
--
-- WHY A NEW TABLE VS EXTENDING nps_state
-- ──────────────────────────────────────
-- `nps_state` is a singleton snapshot (current units + current NAVs per
-- scheme). It answers "what do I hold right now?" but knows nothing
-- about history. This table answers "how did I get here?" — every
-- deposit event with its NAV date and units allocated.
--
-- The two are independent by design:
--   • nps_state is refreshed daily from npsnav.in / Kotak (cheap)
--   • nps_transactions is a one-shot backfill per FY, immutable
--     historical facts (units and NAVs on past dates never change)
--
-- IDEMPOTENCY
-- ───────────
-- (source, tx_hash) is UNIQUE. tx_hash is md5 over the full source
-- row — same statement re-pasted produces the same hashes, so re-apply
-- is a no-op. If two rows would hash identically (rare but possible
-- for e.g. same-day-same-amount deposits across schemes with identical
-- NAVs), the parser appends a dupeSeq — same mechanism as
-- `mf_transactions.tx_hash` (see 2026-07-18-mf-transactions.sql).

create table if not exists nps_transactions (
  id bigserial primary key,

  -- Provenance. Currently 'protean_cra_sot'; 'kfin_cra_sot' anticipated
  -- if the user's CRA later moves.
  source text not null,

  -- md5 idempotency key (see file header).
  tx_hash text not null,

  -- NAV / posting date — the date units were allotted at the given NAV,
  -- NOT the date the money left the employer's account. For arrear
  -- contributions there's a 1-2 week gap between the two; CRA reports
  -- the NAV date because that's the date that matters for returns.
  tx_date date not null,

  -- Financial year the parent statement covered — 'YYYY-YY'. Not derivable
  -- from tx_date alone because e.g. an FY23-24 statement can contain a
  -- billing row dated in Apr 2024 (Q4 billing runs after FY close).
  fy text not null,

  -- Tier: 'I' | 'II' | 'TTS' — matches the CRA vocabulary.
  tier text not null,

  -- Scheme: 'E' (equity) | 'C' (corporate debt) | 'G' (government bonds)
  --   | 'A' (alternative assets, if opted in).
  scheme text not null,

  -- Normalized transaction category:
  --   contribution   — regular / lumpsum SIP-like deposits, "By Arrear -
  --                    Regular Contribution [Month]" from CRA. Includes
  --                    the initial joining lumpsum (per user's spec:
  --                    "consider that as sip only").
  --   billing        — quarterly CRA charges (units debited, small
  --                    negative amounts). Filtered out of default views.
  --   switch_in      — inflow from scheme-preference change
  --   switch_out     — outflow from scheme-preference change
  --   shifting_in    — inflow from sector shift (Corporate → All-Citizen etc.)
  --   shifting_out   — outflow from sector shift
  --   withdrawal     — partial/exit withdrawal (Tier I: rare pre-retirement)
  --   other          — unrecognised description — flagged for review
  tx_type text not null,

  -- Money flow. amount is signed: negative for billing / switch_out /
  -- withdrawal, positive otherwise. nav and units follow the same
  -- convention (units go negative on debits).
  amount numeric(14, 2) not null default 0,
  nav numeric(14, 4),
  units numeric(18, 4),

  -- Source-of-funds side. Corporate NPS via the employer routes the full
  -- amount as 'employer' in the CRA statement (even the salary-deducted
  -- employee share, because CRA sees only the employer's bulk wire).
  -- 'voluntary' would be user-initiated direct deposits via eNPS.
  --   'employer' | 'employee' | 'voluntary' | null (billing / non-cash)
  contribution_side text,

  -- Audit fields.
  description_raw text,       -- "By Arrear - Regular Contributions March"
  uploaded_by text,           -- "Kotak Mahindra Bank Limited (5000041)"
  raw jsonb,                  -- Full source row for post-hoc audit

  created_at timestamptz not null default now(),

  constraint nps_transactions_source_hash_uk unique (source, tx_hash)
);

-- Indexes chosen to match downstream query shapes:
--   • Date-range scans (chart: contributions in a window)
--   • Per-scheme drilldown (E/C/G breakdown)
--   • Per-FY filter (annual report views)
create index if not exists nps_transactions_tx_date_idx on nps_transactions (tx_date);
create index if not exists nps_transactions_scheme_idx on nps_transactions (scheme);
create index if not exists nps_transactions_tier_idx on nps_transactions (tier);
create index if not exists nps_transactions_fy_idx on nps_transactions (fy);
create index if not exists nps_transactions_source_idx on nps_transactions (source);

-- RLS: locked down like every other table (see 2026-07-18-enable-rls.sql).
alter table nps_transactions enable row level security;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'nps_transactions';
--   -- expects: (nps_transactions, t)
--
--   select count(*) from nps_transactions;
--   -- expects: 0 initially
