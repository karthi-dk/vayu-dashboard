-- ─── mf_transactions.platform / mf_contributions.platform ────────────────
--
-- Adds a first-class `platform` column to BOTH MF ledger tables,
-- capturing WHERE the order was actually placed (Groww app, INDmoney
-- app, ICICI Prudential direct-AMC app, etc.) — a distinct dimension
-- from the existing `source` column, which conflates ingest mechanism
-- with purchase platform.
--
-- WHY THIS IS A DIFFERENT DIMENSION FROM `source`
-- ───────────────────────────────────────────────
--   `source` tells you HOW THE ROW ENTERED THE DB:
--     • 'groww'          — parsed from Groww's JSON via /api/sync-mf-contributions
--     • 'mfcentral_cas'  — parsed from MFCentral eCAS Excel (ingest path retired)
--     • 'manual'         — wrote via the /sync page's manual form OR its
--                          INDmoney paste helper (both flow through the
--                          logMfTransaction server action)
--
--   `platform` tells you WHERE THE TRADE ACTUALLY HAPPENED:
--     • 'groww'          — Groww broker app
--     • 'indmoney'       — INDmoney app or web
--     • 'icici_prudential', 'hdfc_mf', 'nippon_mf', 'edelweiss_mf',
--       'uti_mf', 'ppfas_mf', 'kotak_mf' — direct-AMC apps
--     • 'dhan'           — Dhan (used briefly, retained for historical)
--     • 'other'          — user-chosen catch-all
--     • NULL             — genuinely unknown (typical for CAS-sourced
--                          rows, which don't carry the originating
--                          platform in their payload — CAS is a
--                          reconciliation feed from the AMC/RTA side,
--                          not a broker feed)
--
-- The two dimensions overlap for some values ('groww' means both "row
-- came via Groww's API" AND "trade was placed on Groww") — that's
-- correct, and having platform stored explicitly lets the ledger UI
-- filter/group on the "where did I actually place this?" question
-- without having to reason about ingest paths.
--
-- WHY NO CHECK CONSTRAINT ON THE VOCABULARY
-- ─────────────────────────────────────────
-- Soft vocabulary managed in code (lib/mf/platform.ts) — that lets a
-- brand-new platform be added by editing one TypeScript file without
-- needing a follow-up migration. The trade-off is that a typo could
-- introduce a phantom platform value, but the write paths are all
-- funnelled through logMfTransaction (which picks from the code-side
-- enum via a dropdown) or through the two paste parsers (which
-- hardcode 'indmoney' or 'groww'), so free-form typos in practice
-- shouldn't happen.

alter table mf_transactions
  add column if not exists platform text;

alter table mf_contributions
  add column if not exists platform text;

-- ─── Deterministic backfill ──────────────────────────────────────────────
--
-- Only two safe inferences:
--   1. Every row in mf_contributions came from Groww paste — that
--      table has never been fed by anything else. Existing rows all
--      get platform='groww'.
--   2. mf_transactions rows with a source_ref were tagged today via
--      the INDmoney bulk-list / order-detail paste paths (source_ref
--      isn't populated by any other ingest). Those get
--      platform='indmoney'.
--
-- Everything else (source='mfcentral_cas' historical rows, source=
-- 'manual' rows without source_ref that predate this migration) stays
-- NULL — genuinely unknown platform, retro-taggable via the UI as the
-- user encounters them in the ledger. Deliberately NOT guessing from
-- description_raw text — the small chance of misfiring is worse than
-- honestly leaving it null.

update mf_contributions
  set platform = 'groww'
  where platform is null;

update mf_transactions
  set platform = 'indmoney'
  where platform is null
    and source_ref is not null;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   -- Column presence + type
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_name in ('mf_transactions', 'mf_contributions')
--     and column_name = 'platform';
--   -- expects: 2 rows, both text, both nullable
--
--   -- Backfill coverage
--   select 'mf_contributions' as tbl, platform, count(*)
--   from mf_contributions
--   group by platform
--   union all
--   select 'mf_transactions', platform, count(*)
--   from mf_transactions
--   group by platform
--   order by tbl, platform nulls last;
--   -- expects: mf_contributions all 'groww', mf_transactions mix of
--   -- 'indmoney' (for rows tagged post-2026-07-24) and null (older)
