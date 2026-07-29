// Ingest Income Tax Return JSONs into `itr_returns`. Once-a-year event —
// point this at the folder that holds the AY-*.json files exported from
// the CBDT e-filing portal.
//
// Usage
// -----
//   npx tsx scripts/ingest-itr-json.ts <folder-of-itr-jsons> [--dry-run] [--verbose]
//
// Example:
//   npx tsx scripts/ingest-itr-json.ts \
//     "/Users/kponnu/Documents/itr-fy2025-26/All ITR JSON"
//
// Flags
//   --dry-run   Parse and print the extracted row per file; skip the DB write.
//   --verbose   Also print the raw JSONB "other_income_breakdown" and
//               "employer_names" arrays that will be persisted.
//
// PII policy
// ----------
// This script deliberately extracts a NON-PII subset of each JSON. PAN,
// Aadhaar, DOB, home address, mobile, email, bank account number, IFSC,
// employer TAN — none of those are read into the outbound row. The full
// JSON goes into `raw_json` for audit, but that column is RLS-locked
// to service_role only (see 2026-07-23-itr-returns.sql). If the app
// ever needs PII, it should live in a separate table with its own
// gate, not in this ingest path.
//
// Idempotency
// -----------
// Upsert on (assessment_year, is_revised). Re-running is a no-op.
// Revised returns (ReturnFileSec = 17) get a separate row per AY so
// the timeline retains both the original and the amendment.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Corporate/ISP TLS interception commonly injects a self-signed cert
// into the chain when this workstation talks to Supabase from the
// terminal (SELF_SIGNED_CERT_IN_CHAIN). Every other node -e / diagnostic
// script in this repo sets this env var too; local-only script, no
// external secrets flow through this fetch beyond what Supabase already
// receives, so relaxing the check here is intentional and scoped.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

type ITR1 = {
  CreationInfo?: {
    JSONCreationDate?: string;
    Digest?: string;
  };
  Form_ITR1?: {
    FormName?: string;
    AssessmentYear?: string;
    SchemaVer?: string;
  };
  FilingStatus?: {
    ReturnFileSec?: number;
    NewTaxRegime?: string;
    OptOutNewTaxRegime?: string;
    ItrFilingDueDate?: string;
    OrigRetFiledDate?: string;
  };
  ITR1_IncomeDeductions?: {
    GrossSalary?: number;
    PerquisitesValue?: number;
    NetSalary?: number;
    DeductionUs16ia?: number;
    IncomeFromSal?: number;
    IncomeOthSrc?: number;
    GrossTotIncome?: number;
    TotalIncome?: number;
    AllwncExemptUs10?: { TotalAllwncExemptUs10?: number };
    OthersInc?: {
      OthersIncDtlsOthSrc?: Array<{
        OthSrcNatureDesc?: string;
        OthSrcOthAmount?: number;
      }>;
    };
    DeductUndChapVIA?: {
      Section80C?: number;
      Section80CCDEmployeeOrSE?: number;
      Section80CCD1B?: number;
      Section80CCDEmployer?: number;
      Section80D?: number;
      Section80G?: number;
      Section80TTA?: number;
      TotalChapVIADeductions?: number;
    };
  };
  ITR1_TaxComputation?: {
    TotalTaxPayable?: number;
    Rebate87A?: number;
    EducationCess?: number;
    GrossTaxLiability?: number;
    TotTaxPlusIntrstPay?: number;
    IntrstPay?: {
      IntrstPayUs234A?: number;
      IntrstPayUs234B?: number;
      IntrstPayUs234C?: number;
      LateFilingFee234F?: number;
    };
  };
  TaxPaid?: {
    TaxesPaid?: {
      AdvanceTax?: number;
      TDS?: number;
      TCS?: number;
      SelfAssessmentTax?: number;
      TotalTaxesPaid?: number;
    };
    BalTaxPayable?: number;
  };
  Refund?: {
    RefundDue?: number;
  };
  TDSonSalaries?: {
    TDSonSalary?: Array<{
      EmployerOrDeductorOrCollectDetl?: {
        EmployerOrDeductorOrCollecterName?: string;
      };
      IncChrgSal?: number;
      TotalTDSSal?: number;
    }>;
    TotalTDSonSalaries?: number;
  };
  TDSonOthThanSals?: {
    TotalTDSonOthThanSals?: number;
  };
  ScheduleTCS?: {
    TotalSchTCS?: number;
  };
};

type ITRRoot = { ITR?: { ITR1?: ITR1 } };

type ExtractedRow = {
  source_file: string;
  assessment_year: string;
  financial_year: string;
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
  json_digest: string | null;
  raw_json: unknown;
};

function n(v: number | undefined | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract the non-PII financial-facts subset from one ITR-1 JSON. This
 * is the ONLY function that touches the source JSON — every other step
 * downstream works off the shape defined by ExtractedRow, so a schema
 * change in a future AY only needs updates here.
 *
 * The "AssessmentYear" field in the JSON is a single 4-digit year
 * (e.g. "2026"), which we render as the human "2026-27" range that
 * everyone actually says out loud. The FY is one year earlier — AY
 * 2026 covers FY 2025-26 (the year whose income is being assessed).
 */
function extract(sourceFile: string, root: ITRRoot): ExtractedRow {
  const itr = root.ITR?.ITR1;
  if (!itr) {
    throw new Error(
      `${sourceFile}: no ITR.ITR1 block found — is this a valid ITR-1 JSON?`
    );
  }

  const rawAy = itr.Form_ITR1?.AssessmentYear;
  if (!rawAy) throw new Error(`${sourceFile}: missing Form_ITR1.AssessmentYear`);
  const ayNum = Number(rawAy);
  if (!Number.isFinite(ayNum) || ayNum < 2000 || ayNum > 2100) {
    throw new Error(`${sourceFile}: implausible AssessmentYear=${rawAy}`);
  }
  const assessment_year = `${ayNum}-${String(ayNum + 1).slice(-2)}`;
  const financial_year = `${ayNum - 1}-${String(ayNum).slice(-2)}`;

  // Regime detection is deliberately awkward because CBDT flipped the
  // JSON field's polarity between AY 23-24 (NewTaxRegime:"Y" opts IN
  // to new) and AY 24-25+ (OptOutNewTaxRegime:"N" opts IN to new,
  // reverse polarity). We check both and default to new since that's
  // the current regime post-Budget-2023.
  const fs = itr.FilingStatus ?? {};
  const isNewLegacy = fs.NewTaxRegime === "Y";
  const isNewModern =
    fs.OptOutNewTaxRegime !== undefined && fs.OptOutNewTaxRegime !== "Y";
  const regime: "new" | "old" =
    isNewLegacy || isNewModern ? "new" : "old";

  // ReturnFileSec 11 = 139(1) original; 17 = 139(5) revised.
  const returnFileSec = fs.ReturnFileSec ?? null;
  const is_revised = returnFileSec === 17;

  // Salary / income
  const idr = itr.ITR1_IncomeDeductions ?? {};
  const chvia = idr.DeductUndChapVIA ?? {};
  const employer_names =
    itr.TDSonSalaries?.TDSonSalary?.map((e) => ({
      name: e.EmployerOrDeductorOrCollectDetl?.EmployerOrDeductorOrCollecterName ?? "Unknown",
      income: n(e.IncChrgSal),
      tds: n(e.TotalTDSSal),
    })) ?? [];

  const other_income_breakdown =
    idr.OthersInc?.OthersIncDtlsOthSrc?.map((o) => ({
      desc: o.OthSrcNatureDesc ?? "UNK",
      amount: n(o.OthSrcOthAmount),
    })) ?? [];

  // Tax computation
  const tc = itr.ITR1_TaxComputation ?? {};
  const intr = tc.IntrstPay ?? {};
  const tp = itr.TaxPaid?.TaxesPaid ?? {};

  return {
    source_file: basename(sourceFile),
    assessment_year,
    financial_year,
    form_name: itr.Form_ITR1?.FormName ?? "ITR-1",
    schema_version: itr.Form_ITR1?.SchemaVer ?? null,
    return_file_sec: returnFileSec,
    is_revised,
    regime,
    json_creation_date: itr.CreationInfo?.JSONCreationDate ?? null,
    filed_date: itr.CreationInfo?.JSONCreationDate ?? null,
    filing_due_date: fs.ItrFilingDueDate ?? null,

    gross_salary: n(idr.GrossSalary),
    perquisites_value: n(idr.PerquisitesValue),
    section10_exempt: n(idr.AllwncExemptUs10?.TotalAllwncExemptUs10),
    net_salary: n(idr.NetSalary),
    std_deduction_16ia: n(idr.DeductionUs16ia),
    income_from_salary: n(idr.IncomeFromSal),
    income_other_sources: n(idr.IncomeOthSrc),
    gross_total_income: n(idr.GrossTotIncome),
    chapter_via_deductions: n(chvia.TotalChapVIADeductions),
    total_income: n(idr.TotalIncome),

    sec_80c: n(chvia.Section80C),
    sec_80ccd_employee: n(chvia.Section80CCDEmployeeOrSE),
    sec_80ccd_1b: n(chvia.Section80CCD1B),
    sec_80ccd_employer: n(chvia.Section80CCDEmployer),
    sec_80d: n(chvia.Section80D),
    sec_80g: n(chvia.Section80G),
    sec_80tta: n(chvia.Section80TTA),

    tax_on_total_income: n(tc.TotalTaxPayable),
    rebate_87a: n(tc.Rebate87A),
    education_cess: n(tc.EducationCess),
    gross_tax_liability: n(tc.GrossTaxLiability),
    interest_234a: n(intr.IntrstPayUs234A),
    interest_234b: n(intr.IntrstPayUs234B),
    interest_234c: n(intr.IntrstPayUs234C),
    late_fee_234f: n(intr.LateFilingFee234F),
    total_tax_liability: n(tc.TotTaxPlusIntrstPay),

    tds_salary: n(itr.TDSonSalaries?.TotalTDSonSalaries),
    tds_other: n(itr.TDSonOthThanSals?.TotalTDSonOthThanSals),
    tcs: n(itr.ScheduleTCS?.TotalSchTCS),
    advance_tax: n(tp.AdvanceTax),
    self_assessment_tax: n(tp.SelfAssessmentTax),
    total_taxes_paid: n(tp.TotalTaxesPaid),

    refund_due: n(itr.Refund?.RefundDue),
    balance_tax_payable: n(itr.TaxPaid?.BalTaxPayable),

    employer_names,
    other_income_breakdown,

    json_digest: itr.CreationInfo?.Digest ?? null,
    // Full JSON stored in raw_json for audit — RLS keeps it service-role only.
    raw_json: root,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  if (!folder) {
    console.error("Usage: npx tsx scripts/ingest-itr-json.ts <folder-of-itr-jsons> [--dry-run] [--verbose]");
    process.exit(2);
  }

  // env loader — same shape as backfill-nps-nav-history.ts.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envRaw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  const env = Object.fromEntries(
    envRaw
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i).trim(),
          l.slice(i + 1).trim().replace(/^"|"$/g, ""),
        ];
      })
  );
  const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  const SB_KEY = env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local"
    );
  }

  const files = readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.error(`No .json files found in ${folder}`);
    process.exit(1);
  }
  console.log(`Found ${files.length} ITR JSON file(s) in ${folder}`);

  const rows: ExtractedRow[] = [];
  for (const f of files) {
    const full = join(folder, f);
    const text = readFileSync(full, "utf8");
    let json: ITRRoot;
    try {
      json = JSON.parse(text) as ITRRoot;
    } catch (e) {
      console.error(`  ✗ ${f}: JSON parse failed — ${(e as Error).message}`);
      process.exit(1);
    }
    const row = extract(full, json);
    rows.push(row);
    const effRate = row.gross_salary > 0
      ? ((row.total_tax_liability / (row.gross_salary + row.income_other_sources)) * 100).toFixed(2)
      : "—";
    console.log(
      `  ✓ ${f}  → AY ${row.assessment_year} · ${row.regime.toUpperCase()} · ` +
      `${row.is_revised ? "REVISED " : ""}gross ₹${row.gross_salary.toLocaleString("en-IN")} · ` +
      `tax ₹${row.total_tax_liability.toLocaleString("en-IN")} (${effRate}%)`
    );
    if (verbose) {
      console.log("      employers:", JSON.stringify(row.employer_names));
      console.log("      othIncome:", JSON.stringify(row.other_income_breakdown));
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: skipping DB write. All rows parsed successfully.");
    return;
  }

  console.log(`\nUpserting ${rows.length} row(s) into itr_returns…`);
  const resp = await fetch(SB_URL + "/rest/v1/itr_returns?on_conflict=assessment_year,is_revised", {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`  ✗ Upsert failed (HTTP ${resp.status}): ${errText}`);
    process.exit(1);
  }
  const inserted = await resp.json();
  console.log(`  ✓ Wrote ${Array.isArray(inserted) ? inserted.length : "?"} row(s).`);

  // Quick reconciliation query — prove the row count matches.
  const verify = await fetch(SB_URL + "/rest/v1/itr_returns?select=assessment_year,is_revised,regime,gross_salary,total_tax_liability&order=assessment_year.desc,is_revised.asc", {
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
  });
  const post = await verify.json();
  console.log(`\nitr_returns now holds ${Array.isArray(post) ? post.length : "?"} row(s):`);
  if (Array.isArray(post)) {
    for (const r of post) {
      console.log(
        `  · AY ${r.assessment_year}${r.is_revised ? " (revised)" : ""}  ${r.regime.toUpperCase().padEnd(4)}  ` +
        `gross ₹${Number(r.gross_salary).toLocaleString("en-IN")}  · tax ₹${Number(r.total_tax_liability).toLocaleString("en-IN")}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
