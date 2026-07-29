-- ─── mf_transactions ──────────────────────────────────────────────────────
--
-- Lifetime lot-level MF transaction ledger, primarily fed by one-time
-- MFCentral eCAS Excel ingestion. Complements the existing
-- `mf_contributions` table (Groww-sourced daily incremental) rather than
-- replacing it:
--
--   • mf_transactions: authoritative historical record. Populated from
--     MFCentral eCAS. Covers every transaction on every folio across
--     every AMC — SIPs, lumpsums, redemptions, switches, dividends.
--     Idempotent per (source, tx_hash).
--
--   • mf_contributions: rolling incremental log for orders too fresh to
--     be in CAS yet (Groww JSON syncs). New orders land here first;
--     next CAS refresh (if any) subsumes them.
--
-- Downstream queries UNION both tables and prefer mf_transactions where
-- the date range overlaps (CAS is ground truth from the AMC/RTA side;
-- Groww is intermediary reporting).
--
-- WHY tx_hash INSTEAD OF (folio, fund_code, date, amount, units)
-- ──────────────────────────────────────────────────────────────
-- A composite unique on those columns would block legitimate
-- same-day-same-amount SIPs, and requires exact numeric equality on
-- floats (fragile across parsing rounds). `tx_hash` is a deterministic
-- md5 over the full source row (folio || scheme || date || desc ||
-- amount || units) — same-file re-import is idempotent, but two
-- distinct SIP orders on the same day for the same amount produce
-- different hashes if their descriptions differ (they always do —
-- CAMS gives "Instalment N/M" in the description text).

create table if not exists mf_transactions (
  id bigserial primary key,

  -- Provenance. Currently only 'mfcentral_cas', but 'kfintech_cas',
  -- 'groww_cas', 'camsonline_cas' etc. are anticipated future values.
  source text not null,

  -- Stable idempotency key: md5 over the full source row. Enforces
  -- one-shot import behaviour — re-uploading the same CAS file
  -- doesn't duplicate rows.
  tx_hash text not null,

  -- Business fields.
  tx_date date not null,
  -- References fund_holdings.fund_code loosely (no FK because
  -- fund_holdings can be reseeded whereas this ledger is retention-
  -- critical; we don't want a fund_holdings truncate to cascade-delete
  -- five years of ledger history).
  fund_code text not null,
  folio_number text not null,

  -- Normalized transaction category:
  --   purchase       — lumpsum buy (including "SIP Purchase" — kept as
  --                    a purchase because the money hits the AMC identically)
  --   sip_registration — SIP mandate created (amount = 0, keep for audit)
  --   sip_cancellation — SIP mandate cancelled (amount = 0, keep for audit)
  --   redemption     — sell (units negative)
  --   switch_in      — switch received
  --   switch_out     — switch sent (units negative)
  --   dividend       — dividend payout / reinvestment
  --   other          — anything the classifier didn't recognise; flagged
  --                    for manual review
  tx_type text not null,

  -- Money flow. `amount` is the deployed amount AFTER stamp duty (which
  -- is what CAS reports). `nav` × `units` should reconcile to `amount`
  -- within ~₹1 of stamp-duty rounding. `units` is signed: positive for
  -- purchases / switch_in / dividend-reinvest, negative for redemptions
  -- / switch_out.
  amount numeric(14, 2) not null default 0,
  nav numeric(14, 4),
  units numeric(18, 4),

  -- Audit fields. `scheme_name_raw` and `description_raw` are the exact
  -- text from the CAS row — useful when the classifier fails or the
  -- user asks "why is this classified as X?".
  scheme_name_raw text not null,
  description_raw text,
  -- Full source row (JSONB) — belt-and-braces audit. Cheap because
  -- rows are small and read frequency is near-zero.
  raw jsonb,

  created_at timestamptz not null default now(),

  constraint mf_transactions_source_hash_uk unique (source, tx_hash)
);

-- Indexes chosen to match downstream query shapes:
--   • Date-range scans (chart: "transactions in this window")
--   • Per-fund history (fund detail modal)
--   • Per-folio grouping (reconciliation reports)
create index if not exists mf_transactions_tx_date_idx on mf_transactions (tx_date);
create index if not exists mf_transactions_fund_code_idx on mf_transactions (fund_code);
create index if not exists mf_transactions_folio_idx on mf_transactions (folio_number);
create index if not exists mf_transactions_source_idx on mf_transactions (source);

-- RLS: locked down by default. Only reachable via service_role client
-- from Next.js server components / route handlers, matching the rest
-- of the tables secured by 2026-07-18-enable-rls.sql.
alter table mf_transactions enable row level security;

-- ─── Verification ──────────────────────────────────────────────────────────
-- Run after applying to confirm the table + RLS state:
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'mf_transactions';
--   -- expects: (mf_transactions, t)
--
--   select count(*) from mf_transactions;
--   -- expects: 0 initially
