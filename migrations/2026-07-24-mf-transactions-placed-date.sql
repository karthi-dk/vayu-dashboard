-- ─── mf_transactions.placed_date ─────────────────────────────────────────
--
-- Adds a nullable `placed_date` column separating the "when the user
-- clicked Buy" date from the "when units were priced" date already
-- stored in `tx_date`.
--
-- WHY THIS IS NEEDED
-- ──────────────────
-- The pre-fix ingest path treated INDmoney bulk-list Subtitle1 (the
-- user-facing "Order Date") as the transaction date, storing it into
-- `tx_date`. But INDmoney's bulk-list Subtitle1 is the CLICK date in
-- the user's local time, which for a post-3PM-cutoff order can be a
-- calendar day earlier than the day whose NAV was actually applied.
--
-- Real example that surfaced this bug (INDmoney TxnID 74974058):
--   • Bulk-list Subtitle1:  "22 Jul 2026"       ← the click date
--   • Order-detail:         Order 23 Jul 02:50, Payment 23 Jul 02:52
--   • NAV Date:             23 Jul 2026 (post-cutoff → next-day NAV)
--   • Units allotted:       24 Jul 2026 (T+1)
--   • NAV value applied:    ₹126.20 (which is EDEL_MID's 23-Jul close,
--                                     NOT 22-Jul's)
--
-- SEMANTIC DEFINITIONS AFTER THIS MIGRATION
-- ─────────────────────────────────────────
--   tx_date       — the NAV DATE (day whose NAV was applied to allot
--                    units). Aligned with the CAS convention: eCAS
--                    reports a "Transaction Date" which IS the NAV
--                    date for equity funds. This is also what the
--                    tx_hash formula hashes over, so tx_hash stays
--                    tied to the NAV date across all ingest paths.
--   placed_date   — when the user clicked Buy (bulk-list Subtitle1
--                    for INDmoney, or user-entered for hand-typed
--                    entries). Distinct from tx_date whenever the
--                    order crossed the 3 PM cutoff or hit a weekend/
--                    holiday. Null on CAS rows and any manual entry
--                    that pre-dates this column.
--
-- Both dates are exposed on the ledger UI as a 2-line "Placed / NAV"
-- stack when placed_date != tx_date; when they're the same (typical
-- T+0 equity SIP), the UI folds to a single date.

alter table mf_transactions
  add column if not exists placed_date date;

comment on column mf_transactions.placed_date is
  'When the user clicked Buy (INDmoney Subtitle1 order date, or user input for hand-typed entries). Distinct from tx_date, which stores the NAV date (day whose NAV was applied). Nullable — legacy rows and CAS rows leave this null.';

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   -- Column presence + type
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_name = 'mf_transactions' and column_name = 'placed_date';
--   -- expects: 1 row, date, nullable=YES
--
--   -- Pre-fix state: existing manual rows have placed_date NULL
--   select count(*) as legacy_manual_rows_with_null_placed_date
--   from mf_transactions
--   where source = 'manual' and placed_date is null;
