// Client-safe types and pure helpers for the Filings page.
//
// Kept separate from lib/filings.ts because that file imports the
// server-only Supabase client — any client component that reaches for
// a type there ends up violating Next.js's server-only boundary at
// build time. Split like this: types + pure math live here (importable
// from anywhere), the data-layer query lives in filings.ts.

export type ItrReturn = {
  id: number;
  assessment_year: string;   // "2026-27"
  financial_year: string;    // "2025-26"
  form_name: string;
  schema_version: string | null;
  return_file_sec: number | null;
  is_revised: boolean;
  regime: "new" | "old";
  json_creation_date: string | null;
  filed_date: string | null;
  filing_due_date: string | null;

  gross_salary: number;
  perquisites_value: number;
  section10_exempt: number;
  net_salary: number;
  std_deduction_16ia: number;
  income_from_salary: number;
  income_other_sources: number;
  gross_total_income: number;
  chapter_via_deductions: number;
  total_income: number;

  sec_80c: number;
  sec_80ccd_employee: number;
  sec_80ccd_1b: number;
  sec_80ccd_employer: number;
  sec_80d: number;
  sec_80g: number;
  sec_80tta: number;

  tax_on_total_income: number;
  rebate_87a: number;
  education_cess: number;
  gross_tax_liability: number;
  interest_234a: number;
  interest_234b: number;
  interest_234c: number;
  late_fee_234f: number;
  total_tax_liability: number;

  tds_salary: number;
  tds_other: number;
  tcs: number;
  advance_tax: number;
  self_assessment_tax: number;
  total_taxes_paid: number;

  refund_due: number;
  balance_tax_payable: number;

  employer_names: Array<{ name: string; income: number; tds: number }>;
  other_income_breakdown: Array<{ desc: string; amount: number }>;

  source_file: string | null;
  json_digest: string | null;
  created_at: string;
  updated_at: string;
};

export type FilingsCumulative = {
  years: number;
  totalGrossEarned: number;
  totalTaxPaid: number;
  overallEffectiveRate: number;
};

/**
 * "Out of every ₹100 earned, how much went to tax this year." Denominator
 * is gross salary + other-source income (i.e. pre-any-deduction total).
 * We match Groww / EPFO's convention of "total gross earned" rather than
 * "total income post-deductions" — the user's ask was in ₹100-earned
 * terms, and pre-deduction gross is the closest match to "what came in".
 */
export function effectiveRatePct(r: ItrReturn): number {
  const denom = r.gross_salary + r.income_other_sources;
  return denom > 0 ? (r.total_tax_liability / denom) * 100 : 0;
}

/**
 * Take-home fraction as a paise-per-rupee value for chart labels
 * ("You kept ₹80 of every ₹100"). Complement of effectiveRatePct.
 */
export function takeHomePct(r: ItrReturn): number {
  return 100 - effectiveRatePct(r);
}
