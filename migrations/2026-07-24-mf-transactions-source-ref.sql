-- ─── mf_transactions.source_ref ───────────────────────────────────────────
--
-- Adds a nullable `source_ref` column carrying the SOURCE SYSTEM's own
-- unique identifier for a transaction — INDmoney's TxnID today, and
-- any future integration that surfaces a stable per-order ID from an
-- upstream broker/AMC (Groww's orderId, Zerodha's transactionId, etc.).
--
-- WHY THIS EXISTS ALONGSIDE tx_hash
-- ──────────────────────────────────
-- tx_hash is a DERIVED key (md5 over fund_code + tx_date + tx_type +
-- net-amount-in-paise), which means idempotency depends on all four
-- inputs reconstructing identically across every ingest path for the
-- same real-world trade. For CAS/manual entries that's fine — the
-- rupee amount is a stable input the user actually types. For
-- INDmoney's bulk order-history list, however, the amount is
-- displayed as "₹10K"/"₹2L"/etc. — reliable only for round-number
-- SIPs; a real order of ₹9,876 would abbreviate to the SAME "₹10K"
-- and the derived tx_hash would then differ from what an earlier
-- order-detail paste (with the exact "Buy Amount: ₹9,876") already
-- wrote, silently inserting a second near-duplicate row.
--
-- source_ref sidesteps that entirely — INDmoney's TxnID is a stable,
-- authoritative primary key on their side, unique per real order and
-- consistent across every JSON shape they expose (order-detail
-- screen, bulk order-history list, transaction-status webhook if we
-- ever wire one). Whenever the ingest path can supply a source_ref,
-- it's checked FIRST (via the partial unique index below) — cheap
-- rejection of exact duplicates before we even reach for a NAV
-- lookup, and immune to any display-rounding artefact on the amount.
--
-- The tx_hash mechanism stays as the fallback for ingest paths that
-- have no natural source-side ID: hand-typed entries for AMC apps
-- that don't return one (ICICI Prudential, HDFC MF, etc.), a future
-- CAS re-paste (CAS's rows already carry their own tx_hash and no
-- external order ID), and cross-source dedup when the same trade
-- ends up recorded via both a source-ref path and a hash-only path.
--
-- PARTIAL UNIQUE INDEX, NOT COLUMN UNIQUE
-- ────────────────────────────────────────
-- Nullable columns with a plain UNIQUE constraint behave surprisingly
-- in Postgres — multiple NULLs are allowed by default (which is what
-- we want here: rows without a source-side ID must be allowed to
-- coexist), but the semantics get muddled once you add more sources.
-- A partial index `WHERE source_ref IS NOT NULL` is the explicit,
-- self-documenting form: uniqueness applies iff a source_ref is set,
-- and it's scoped by source so the same string could theoretically
-- appear across two different upstream systems without colliding
-- (extremely unlikely for TxnIDs but cheap insurance for future
-- integrations).

alter table mf_transactions
  add column if not exists source_ref text;

create unique index if not exists mf_transactions_source_ref_uk
  on mf_transactions (source, source_ref)
  where source_ref is not null;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   \d mf_transactions
--   -- expects: source_ref | text | (nullable, no default)
--
--   select indexname, indexdef
--   from pg_indexes
--   where tablename = 'mf_transactions' and indexname = 'mf_transactions_source_ref_uk';
--   -- expects the partial unique index scoped WHERE source_ref IS NOT NULL
--
--   -- Existing rows are untouched — source_ref stays NULL for anything
--   -- ingested before this migration. Backfill isn't attempted (and
--   -- isn't needed): pre-existing rows either have no upstream ID (CAS,
--   -- manual) or lost it (early Groww ingests didn't preserve orderId).
--   select count(*) filter (where source_ref is null) as no_ref,
--          count(*) filter (where source_ref is not null) as with_ref
--   from mf_transactions;
