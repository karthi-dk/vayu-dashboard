-- master_security_classification: first-class `country` + region='International'
-- ============================================================================
-- Foreign developed-markets names (from the iShares MSCI World ingest) were
-- stored in the region/mcap 'US' bucket with the real country tucked into
-- `notes` ("… (Japan)"). This promotes country to a real column and widens the
-- region CHECK so non-US names can live under region='International' instead of
-- the US bucket.
--
-- SAFE: existing regions are only 'India' + 'US', both allowed by the new CHECK.
--
-- AFTER APPLYING: run  node scripts/backfill-master-country.mjs --apply
-- to populate `country` and re-region the non-US iShares constituents.

ALTER TABLE master_security_classification
  ADD COLUMN IF NOT EXISTS country text;

ALTER TABLE master_security_classification
  DROP CONSTRAINT IF EXISTS master_security_classification_region_check;

ALTER TABLE master_security_classification
  ADD CONSTRAINT master_security_classification_region_check
  CHECK (region IN ('India', 'US', 'International'));
