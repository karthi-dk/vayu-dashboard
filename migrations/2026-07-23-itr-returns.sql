-- ─── itr_returns ─────────────────────────────────────────────────────────
--
-- Annual Income Tax Return (ITR-1) history. Fed by the once-a-year CLI:
--
--   npx tsx scripts/ingest-itr-json.ts <folder-of-itr-jsons>
--
-- Each row = one filed return for one Assessment Year (AY). Revised
-- returns get their own row (is_revised=true) so the timeline retains
-- both the original and the corrected filing.
--
-- ── SCOPE / PII POLICY ──
-- ITR JSONs contain heavy PII (PAN, Aadhaar, DOB, home address, mobile,
-- email, bank account #, IFSC, employer TAN). NONE of that is stored
-- here. The columns below are strictly non-personal financial facts:
-- salary, tax, TDS, refund, employer NAMES (not TANs), regime, dates.
-- If PII enrichment is ever needed, it should live in a separate
-- service-role-only table with its own RLS gate — not in this one.
--
-- ── IDEMPOTENCY ──
-- Primary key is (assessment_year, is_revised). Re-running the ingest
-- with the same JSONs is a no-op (upsert on that key). Amending a
-- revised return in place — rare, but possible if the ITR software
-- regenerated the JSON — replaces the existing row (verified via digest).

create table if not exists itr_returns (
  id            bigserial primary key,

  -- e.g. "2026-27" (form's AssessmentYear "2026" + inferred next year).
  -- Keys the row identity. Same AY can have both an original and a
  -- revised return — the composite unique constraint below allows both.
  assessment_year text not null,

  -- Financial year the AY corresponds to, e.g. "2025-26". Derived at
  -- ingest for query convenience — AY 2026 → FY 2025-26.
  financial_year  text not null,

  -- "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4". Currently only ITR-1
  -- supported by the parser; other schemas will need field-map updates.
  form_name       text not null,

  -- SchemaVer + FormVer from the JSON's Form_ITR* block, e.g. "Ver1.0".
  -- Kept for the "which template version was this filed under" audit
  -- trail — CBDT bumps these when the form structure changes.
  schema_version  text,

  -- Section 139(1) = original (11), 139(5) = revised (17), 139(4) =
  -- belated. Persisted as-is so downstream can reason about the exact
  -- filing type; is_revised is a fast boolean derived from ReturnFileSec.
  return_file_sec int,

  is_revised      boolean not null default false,

  -- Regime: 'new' (Section 115BAC, default from AY 24-25) or 'old'.
  -- Derived from either "NewTaxRegime":"Y" (old JSONs) or
  -- "OptOutNewTaxRegime":"N" (newer JSONs — reverse polarity, thanks
  -- CBDT). Consumers read this string; the JSON quirk stays contained.
  regime          text not null check (regime in ('new', 'old')),

  -- Filing dates. json_creation_date is what the ITR software stamped
  -- (usually the filing date, but occasionally a re-generation date).
  -- filed_date is the same value for now; kept as a separate column
  -- so a future e-verified-on / actual-filed-on distinction has a
  -- home without another migration.
  json_creation_date  date,
  filed_date          date,
  filing_due_date     date,

  -- ── Income ──
  -- Rupees, no paisa. ITR rounds to nearest rupee (Section 288A).
  gross_salary            numeric(14, 0) not null default 0,
  perquisites_value       numeric(14, 0) not null default 0,
  section10_exempt        numeric(14, 0) not null default 0,   -- HRA + LTA + Sec 10 allowances
  net_salary              numeric(14, 0) not null default 0,   -- GrossSalary − Sec 10 exempt
  std_deduction_16ia      numeric(14, 0) not null default 0,   -- Section 16(ia) — the ₹50K/₹75K
  income_from_salary      numeric(14, 0) not null default 0,   -- NetSalary − Sec 16 total
  income_other_sources    numeric(14, 0) not null default 0,   -- Interest, dividends, IFD, SAV, TAX refund int
  gross_total_income      numeric(14, 0) not null default 0,   -- Salary + HP + OS + CG (ITR-1 has no CG/HP)
  chapter_via_deductions  numeric(14, 0) not null default 0,   -- Total ChVIA — mostly 80CCD(2) in new regime
  total_income            numeric(14, 0) not null default 0,   -- GTI − ChVIA; tax computed on this

  -- ── Chapter VIA breakdown ──
  -- Only the ones actually used by this filer today; add more columns
  -- when they appear (extend, don't reshape — keeps grep-ability high).
  sec_80c                 numeric(14, 0) not null default 0,
  sec_80ccd_employee      numeric(14, 0) not null default 0,   -- 80CCD(1)
  sec_80ccd_1b            numeric(14, 0) not null default 0,   -- 80CCD(1B) — the ₹50K NPS extra
  sec_80ccd_employer      numeric(14, 0) not null default 0,   -- 80CCD(2) — employer NPS contribution
  sec_80d                 numeric(14, 0) not null default 0,
  sec_80g                 numeric(14, 0) not null default 0,
  sec_80tta               numeric(14, 0) not null default 0,   -- Savings interest — only OLD regime

  -- ── Tax computation ──
  tax_on_total_income     numeric(14, 0) not null default 0,   -- TotalTaxPayable, pre-cess
  rebate_87a              numeric(14, 0) not null default 0,
  education_cess          numeric(14, 0) not null default 0,   -- 4% health & education cess
  gross_tax_liability     numeric(14, 0) not null default 0,   -- Tax + Cess (post 87A)
  interest_234a           numeric(14, 0) not null default 0,   -- Late filing interest
  interest_234b           numeric(14, 0) not null default 0,   -- Advance tax shortfall
  interest_234c           numeric(14, 0) not null default 0,   -- Advance tax deferment
  late_fee_234f           numeric(14, 0) not null default 0,   -- Belated return fee (₹1K/₹5K)
  total_tax_liability     numeric(14, 0) not null default 0,   -- GrossLiability + interest + fees

  -- ── Taxes paid ──
  tds_salary              numeric(14, 0) not null default 0,
  tds_other               numeric(14, 0) not null default 0,   -- Non-salary TDS (bank int, crypto, etc.)
  tcs                     numeric(14, 0) not null default 0,   -- Foreign remittance TCS, etc.
  advance_tax             numeric(14, 0) not null default 0,
  self_assessment_tax     numeric(14, 0) not null default 0,
  total_taxes_paid        numeric(14, 0) not null default 0,

  -- ── Result ──
  refund_due              numeric(14, 0) not null default 0,   -- 0 if balance is payable
  balance_tax_payable     numeric(14, 0) not null default 0,   -- 0 if refund is due

  -- ── Employers (names only; TAN is PII) ──
  -- JSONB array of { name, income } from TDSonSalary. Names only —
  -- TAN is PII and never stored. Powers the "who paid me during this
  -- year" column in the cross-year table.
  employer_names          jsonb not null default '[]'::jsonb,

  -- ── Other-source income breakdown ──
  -- JSONB array of { desc, amount } from OthersIncDtlsOthSrc. Common
  -- descs: 'SAV' (savings int), 'IFD' (FD int), 'TAX' (refund int),
  -- 'DIV' (dividends). Kept in JSON so novel entries flow through
  -- without a migration.
  other_income_breakdown  jsonb not null default '[]'::jsonb,

  -- ── Provenance ──
  source_file             text,           -- e.g. "AY-2026-27.json"
  json_digest             text,           -- CBDT-computed "Digest" field
  raw_json                jsonb,          -- Full source JSON — audit only.
                                          -- RLS keeps this service-role-only
                                          -- so a compromised anon key never
                                          -- leaks the underlying PII fields.

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- One row per (AY, revised-flag). Revised return replaces its own
  -- prior version; original stays alongside so the timeline is intact.
  constraint itr_returns_ay_revised_uk unique (assessment_year, is_revised)
);

create index if not exists itr_returns_ay_idx on itr_returns (assessment_year desc);
create index if not exists itr_returns_fy_idx on itr_returns (financial_year desc);

-- Auto-touch updated_at on any row change so the ingest script's "last
-- refreshed" timestamp on the page stays honest even for in-place
-- updates that don't change the primary key.
create or replace function itr_returns_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists itr_returns_touch_updated_at_trg on itr_returns;
create trigger itr_returns_touch_updated_at_trg
  before update on itr_returns
  for each row execute function itr_returns_touch_updated_at();

-- RLS locked down like every other table — matches 2026-07-18-enable-rls.sql.
-- Service role bypasses; anon has no policies so it can't select at all.
alter table itr_returns enable row level security;

-- ─── Verification ─────────────────────────────────────────────────────────
--
--   select relname, relrowsecurity from pg_class where relname = 'itr_returns';
--   -- expects: (itr_returns, t)
--
--   select assessment_year, is_revised, regime, gross_salary, total_taxes_paid
--   from itr_returns order by assessment_year desc, is_revised;
--   -- After ingest: 6 rows (2022-23 orig + revised, 23-24, 24-25, 25-26, 26-27)
