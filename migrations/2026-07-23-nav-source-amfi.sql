-- Widen fund_holdings.nav_source CHECK constraint to admit 'amfi'.
--
-- BACKGROUND
-- ----------
-- Prior to 2026-07-23 the refresh path used mfapi.in exclusively, so
-- the original constraint was CHECK (nav_source IN ('groww', 'mfapi')).
-- We added AMFI as the primary NAV source (see lib/mf/amfiClient.ts
-- and app/api/refresh-mf-nav/route.ts header for the six-hour dead-
-- window rationale that motivated the switch). Every rotated row now
-- stamps either 'amfi' (AMFI hit) or 'mfapi' (fallback path).
--
-- The code change shipped 2026-07-23 00:35 IST without a matching
-- migration; the very next refresh click failed for 8/10 funds with
-- Postgres error 23514 (check_violation) because 'amfi' wasn't in the
-- allowed list. This migration fixes that.
--
-- NULL is preserved as an allowed value — brand-new fund_holdings
-- rows (before any refresh) start with nav_source = NULL, and the
-- Groww paste path doesn't always stamp it. NULL passes any IN check
-- transparently in Postgres, but stating it explicitly here makes
-- the intent unambiguous for anyone reading the schema.
--
-- Safe to re-run — DROP IF EXISTS + ADD is idempotent.

ALTER TABLE fund_holdings
  DROP CONSTRAINT IF EXISTS fund_holdings_nav_source_check;

ALTER TABLE fund_holdings
  ADD CONSTRAINT fund_holdings_nav_source_check
  CHECK (nav_source IS NULL OR nav_source IN ('groww', 'mfapi', 'amfi'));
