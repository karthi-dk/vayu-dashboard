// Server-only data layer for the Filings page — reads `itr_returns`
// (see migrations/2026-07-23-itr-returns.sql) and derives per-page
// analytics. Ingest side lives at scripts/ingest-itr-json.ts.
//
// The client-safe half (types, pure derived metrics) lives in
// lib/filings-types.ts so client components ("use client") can import
// from that path without dragging the server-only Supabase client
// into their bundle.

import { sbServer as sb } from "./supabase";
import type { ItrReturn, FilingsCumulative } from "./filings-types";

// Re-export the types so existing imports keep working. Consumers
// that only need types should import from filings-types directly.
export type { ItrReturn, FilingsCumulative } from "./filings-types";
export { effectiveRatePct, takeHomePct } from "./filings-types";

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * One-shot fetch for the Filings page. Returns everything the page
 * needs so the server component stays flat.
 *
 * Ordering: `returns` comes back ASCENDING by AY so charts and the
 * cumulative walker can iterate in chronological order. The table
 * component reverses to descending for the visual — that's a UI
 * concern, not a data-layer one.
 *
 * The 42P01 / PGRST205 escape hatch matches every other query in this
 * codebase — if the migration hasn't run yet, we degrade to an empty
 * page rather than crashing. The console warning nudges the user to
 * apply the migration.
 */
export async function getFilingsData(): Promise<{
  returns: ItrReturn[];
  cumulative: FilingsCumulative;
  tableStale: boolean;
}> {
  const res = await sb
    .from("itr_returns")
    .select(
      "id,assessment_year,financial_year,form_name,schema_version,return_file_sec,is_revised,regime," +
      "json_creation_date,filed_date,filing_due_date," +
      "gross_salary,perquisites_value,section10_exempt,net_salary,std_deduction_16ia," +
      "income_from_salary,income_other_sources,gross_total_income,chapter_via_deductions,total_income," +
      "sec_80c,sec_80ccd_employee,sec_80ccd_1b,sec_80ccd_employer,sec_80d,sec_80g,sec_80tta," +
      "tax_on_total_income,rebate_87a,education_cess,gross_tax_liability," +
      "interest_234a,interest_234b,interest_234c,late_fee_234f,total_tax_liability," +
      "tds_salary,tds_other,tcs,advance_tax,self_assessment_tax,total_taxes_paid," +
      "refund_due,balance_tax_payable," +
      "employer_names,other_income_breakdown," +
      "source_file,json_digest,created_at,updated_at"
    )
    .order("assessment_year", { ascending: true })
    .order("is_revised", { ascending: true });

  if (res.error) {
    const code = (res.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      console.warn(
        "[filings] itr_returns table missing — apply migration " +
          "2026-07-23-itr-returns.sql, then run scripts/ingest-itr-json.ts."
      );
      return {
        returns: [],
        cumulative: { years: 0, totalGrossEarned: 0, totalTaxPaid: 0, overallEffectiveRate: 0 },
        tableStale: true,
      };
    }
    throw res.error;
  }

  // Cast the raw response to a permissive record shape before mapping.
  // Reason: the Supabase client here is created without a generated
  // `Database` type (see lib/supabase.ts — service_role client, no
  // codegen), so `.from("itr_returns")` returns a fallback error-union
  // instead of the row type. Rather than adding a codegen step for
  // this one table, we type-narrow explicitly at the boundary and
  // trust the runtime shape returned by PostgREST (which we own).
  const raw = (res.data ?? []) as unknown as Array<Record<string, unknown>>;

  // Coerce numeric string columns to numbers. PostgREST returns
  // Postgres numerics as strings; we do the cast once here so downstream
  // consumers can do straight arithmetic without Number() on every field.
  const returns: ItrReturn[] = raw.map((r) => ({
    ...(r as unknown as ItrReturn),
    gross_salary: Number(r.gross_salary ?? 0),
    perquisites_value: Number(r.perquisites_value ?? 0),
    section10_exempt: Number(r.section10_exempt ?? 0),
    net_salary: Number(r.net_salary ?? 0),
    std_deduction_16ia: Number(r.std_deduction_16ia ?? 0),
    income_from_salary: Number(r.income_from_salary ?? 0),
    income_other_sources: Number(r.income_other_sources ?? 0),
    gross_total_income: Number(r.gross_total_income ?? 0),
    chapter_via_deductions: Number(r.chapter_via_deductions ?? 0),
    total_income: Number(r.total_income ?? 0),
    sec_80c: Number(r.sec_80c ?? 0),
    sec_80ccd_employee: Number(r.sec_80ccd_employee ?? 0),
    sec_80ccd_1b: Number(r.sec_80ccd_1b ?? 0),
    sec_80ccd_employer: Number(r.sec_80ccd_employer ?? 0),
    sec_80d: Number(r.sec_80d ?? 0),
    sec_80g: Number(r.sec_80g ?? 0),
    sec_80tta: Number(r.sec_80tta ?? 0),
    tax_on_total_income: Number(r.tax_on_total_income ?? 0),
    rebate_87a: Number(r.rebate_87a ?? 0),
    education_cess: Number(r.education_cess ?? 0),
    gross_tax_liability: Number(r.gross_tax_liability ?? 0),
    interest_234a: Number(r.interest_234a ?? 0),
    interest_234b: Number(r.interest_234b ?? 0),
    interest_234c: Number(r.interest_234c ?? 0),
    late_fee_234f: Number(r.late_fee_234f ?? 0),
    total_tax_liability: Number(r.total_tax_liability ?? 0),
    tds_salary: Number(r.tds_salary ?? 0),
    tds_other: Number(r.tds_other ?? 0),
    tcs: Number(r.tcs ?? 0),
    advance_tax: Number(r.advance_tax ?? 0),
    self_assessment_tax: Number(r.self_assessment_tax ?? 0),
    total_taxes_paid: Number(r.total_taxes_paid ?? 0),
    refund_due: Number(r.refund_due ?? 0),
    balance_tax_payable: Number(r.balance_tax_payable ?? 0),
  }));

  // For cumulatives + effective rate, use canonical rows (revised wins
  // over original for the same AY). Otherwise a revised row would
  // double-count the year's income & tax against the 5-yr totals.
  const revisedAys = new Set(
    returns.filter((r) => r.is_revised).map((r) => r.assessment_year)
  );
  const canonical = returns.filter(
    (r) => r.is_revised || !revisedAys.has(r.assessment_year)
  );

  const totalGrossEarned = canonical.reduce(
    (sum, r) => sum + r.gross_salary + r.income_other_sources,
    0
  );
  const totalTaxPaid = canonical.reduce(
    (sum, r) => sum + r.total_tax_liability,
    0
  );
  const overallEffectiveRate =
    totalGrossEarned > 0 ? (totalTaxPaid / totalGrossEarned) * 100 : 0;

  return {
    returns,
    cumulative: {
      years: canonical.length,
      totalGrossEarned,
      totalTaxPaid,
      overallEffectiveRate,
    },
    tableStale: false,
  };
}
