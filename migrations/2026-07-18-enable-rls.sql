-- ==========================================================================
-- Enable RLS on all vayu-dashboard tables (deny-all for anon)
-- ==========================================================================
--
-- Run this in Supabase Dashboard → SQL Editor after:
--   1. Copying SUPABASE_SERVICE_KEY into your .env.local
--   2. Restarting `npm run dev` and confirming the app still loads
--
-- What this does
-- --------------
-- Turns on Row Level Security for every table. We don't add any
-- policies — an RLS-enabled table with zero policies denies ALL
-- operations for non-superuser roles. That includes the `anon` role
-- (the one behind the NEXT_PUBLIC_SUPABASE_ANON_KEY publishable key).
--
-- Your Next.js server uses the service_role role, which bypasses RLS
-- entirely. So the app keeps working; only unauthenticated PostgREST
-- calls (i.e. anyone poking at your project URL with the anon key)
-- get rejected.
--
-- Effect summary:
--                    Before          After
--   Browser anon:    full CRUD  →    401 / 403 on every table
--   Server service:  full CRUD  →    unchanged (bypasses RLS)
--
-- Rollback
-- --------
-- If something breaks unexpectedly, you can revert with:
--   ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;
-- for each table. The service_role key doesn't care either way.
--
-- Idempotent
-- ----------
-- `ENABLE ROW LEVEL SECURITY` is idempotent — running this twice is
-- harmless. Safe to re-run after any future table additions.
-- ==========================================================================

ALTER TABLE epf_state                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_holdings                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_holdings_detail           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_non_security_holdings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fund_sync_diagnostics          ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_security_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE nav_history                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE nps_state                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE nw_daily                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_config               ENABLE ROW LEVEL SECURITY;
ALTER TABLE retirement_credits             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_taxonomy                ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- Drop any pre-existing policies (deny-all requires zero policies)
-- ==========================================================================
--
-- Turning RLS on with an existing permissive policy is a footgun — the
-- policy stays in effect, and if it's a "SELECT USING (true)" grant to
-- anon (which Supabase's Table Editor sometimes auto-creates when you
-- toggle RLS in the UI), the table keeps leaking. The verification
-- query at the bottom of this file will surface these as
-- policy_count > 0.
--
-- This DO block drops every policy on our 12 tables so we end at
-- deny-all across the board. Idempotent: on a clean install where
-- no policies exist, the loop runs zero times and does nothing.
--
-- If you ever need to add a real policy back (e.g., an authenticated
-- role for a future multi-user setup), do it AFTER this block runs.
-- ==========================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'epf_state','fund_holdings','fund_holdings_detail',
        'fund_non_security_holdings','fund_sync_diagnostics',
        'master_security_classification','nav_history','nps_state',
        'nw_daily','portfolio_config','retirement_credits','sector_taxonomy'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
    RAISE NOTICE 'Dropped policy % on %.%',
      r.policyname, r.schemaname, r.tablename;
  END LOOP;
END $$;

-- ==========================================================================
-- Verify
-- ==========================================================================
-- Run this after the ALTERs to confirm every table shows rowsecurity = true.
-- The expected output is 12 rows, all with rls_enabled = true.
--
--   SELECT
--     tablename,
--     rowsecurity   AS rls_enabled,
--     (SELECT COUNT(*) FROM pg_policies p
--        WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename
--     )             AS policy_count
--   FROM pg_tables t
--   WHERE schemaname = 'public'
--     AND tablename IN (
--       'epf_state','fund_holdings','fund_holdings_detail',
--       'fund_non_security_holdings','fund_sync_diagnostics',
--       'master_security_classification','nav_history','nps_state',
--       'nw_daily','portfolio_config','retirement_credits','sector_taxonomy'
--     )
--   ORDER BY tablename;
--
-- Expect: rls_enabled = true for all 12 rows; policy_count = 0
-- (zero policies = deny-all for anon, which is exactly what we want).
