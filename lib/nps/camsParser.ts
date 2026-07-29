/**
 * CAMS NPS Transaction Statement CSV parser.
 *
 * The user downloads their Transaction Statement from the CAMS-NPS portal
 * (services.camsnps.in) and pastes the raw CSV into the PasteCasCard on
 * the /sync page. This parser converts the multi-section CSV into a
 * structured ParsedCas that the diff engine (lib/nps/casDiff.ts) can
 * classify against the live DB state.
 *
 * CSV STRUCTURE (as of the Jul 17, 2026 CAMS export format)
 * ---------------------------------------------------------
 * The file has SIX sections, separated by blank lines and identified by
 * fixed header strings (case-insensitive matching, trim'd):
 *
 *   1. "NPS Transaction Statement for Tier I Account"  — file marker
 *   2. "Subscriber Details"                             — PRAN, name, statement date
 *   3. "Investment Summary"                             — 5-column KPI row
 *   4. "Investment Details - Scheme Wise Summary"       — 3-4 rows (E/C/G/A per variant)
 *   5. "Contribution/Redemption Details during the selected period"
 *   6. "Transaction Details"                             — per-scheme sub-sections
 *
 * The parser reads sections independently — if a later section is
 * malformed we still return everything before it, so partial-success
 * cases surface useful data. Any REQUIRED-field failure (PRAN missing,
 * scheme summary empty, no contribution rows) throws.
 *
 * PARSING STRATEGY
 * ----------------
 * 1. Split the whole CSV into lines and iterate with a section pointer.
 * 2. When a known header is encountered, switch the pointer and skip
 *    ahead until non-empty content starts.
 * 3. Inside each section, use column-name matching (not positional
 *    indexing) so column reorderings by CAMS don't break us silently.
 * 4. Currency parsing accepts three forms: "Rs 592172.82", "12345.00",
 *    "(32.64)" (parenthesized negative — CAMS convention for redemptions).
 *
 * WHAT'S FILTERED
 * ---------------
 * The "Contribution/Redemption Details" section is the source of ledger
 * events. Row categorization by "Particulars" text:
 *   • "By Arrear - Regular contribution of ..." → payroll (goes to ledger)
 *   • "By Voluntary Contributions"               → voluntary (baked into
 *                                                   total_invested per the
 *                                                   Jul 17 UX decision)
 *   • Anything else (billing, SPC transfers, etc)  → internal (skipped;
 *                                                     they're only in the
 *                                                     per-scheme Transaction
 *                                                     Details section
 *                                                     anyway, not in this
 *                                                     one on real CAMS
 *                                                     exports)
 *
 * The per-scheme Transaction Details section is parsed BUT only used for
 * sum-consistency validation (Σ closing units matches scheme summary).
 * It's NOT used as a ledger source because it double-counts payroll
 * (one row per scheme = 3 rows per credit).
 */

// ─── Public types ────────────────────────────────────────────────────────

export type SchemeAssetClass = "E" | "C" | "G" | "A";
export type SchemeVariant = "POP" | "DIRECT" | "GS" | "CORP" | "UNKNOWN";
export type SchemeTier = "I" | "II";

export type SchemeSummaryRow = {
  fullName: string;
  assetClass: SchemeAssetClass;
  variant: SchemeVariant;
  tier: SchemeTier;
  units: number;
  nav: number;
  value: number;
  navDateIso: string | null; // Extracted from the section header ("NAV as on 16-Jul-2026")
};

export type ContributionRow = {
  dateIso: string;
  particulars: string;
  uploadedBy: string;
  employeeContribution: number;
  employerContribution: number;
  total: number;
  category: "payroll" | "voluntary" | "internal";
};

export type ParsedCas = {
  raw: {
    charCount: number;
    lineCount: number;
  };
  subscriber: {
    pran: string;
    name: string;
    statementDateIso: string;
    schemeChoice: string | null;
  };
  investmentSummary: {
    totalValue: number;
    numContributions: number;
    totalContribution: number;
    totalWithdrawal: number;
    notionalGainLoss: number;
    intermediaryChargesInr: number;
  };
  schemeSummary: SchemeSummaryRow[]; // one row per E/C/G (usually 3, may be 4 for Active E+C+G+A)
  contributions: ContributionRow[];
  computed: {
    sumOfSchemeValues: number;
    payrollTotal: number;
    voluntaryTotal: number;
  };
};

// ─── Error class for structured failures ─────────────────────────────────

export class CamsParseError extends Error {
  readonly section: string;
  readonly hint?: string;
  constructor(section: string, message: string, hint?: string) {
    super(`[${section}] ${message}`);
    this.name = "CamsParseError";
    this.section = section;
    this.hint = hint;
  }
}

// ─── Section boundary detection ──────────────────────────────────────────

type SectionKey =
  | "header"
  | "subscriber"
  | "summary"
  | "schemeSummary"
  | "contribution"
  | "transaction"
  | "unknown";

// Matches are done on the trim'd line, case-insensitive, exact-startsWith
// so cosmetic CAMS reformatting (adding/removing trailing spaces or
// commas) doesn't drop us out of a section unexpectedly.
const SECTION_MARKERS: { key: SectionKey; regex: RegExp }[] = [
  { key: "header", regex: /^nps\s+transaction\s+statement/i },
  { key: "subscriber", regex: /^subscriber\s+details/i },
  { key: "summary", regex: /^investment\s+summary/i },
  { key: "schemeSummary", regex: /^investment\s+details\s*-\s*scheme\s+wise\s+summary/i },
  {
    key: "contribution",
    regex: /^contribution\/?redemption\s+details/i,
  },
  { key: "transaction", regex: /^transaction\s+details/i },
];

function detectSection(line: string): SectionKey | null {
  const t = line.trim().replace(/^,+|,+$/g, "").trim();
  for (const { key, regex } of SECTION_MARKERS) {
    if (regex.test(t)) return key;
  }
  return null;
}

// ─── Primitive value parsers ─────────────────────────────────────────────

/**
 * Split a CSV line respecting simple double-quoted fields. CAMS's export
 * doesn't quote fields with commas in them (uploader names carry the
 * "(5000041)" suffix which contains a bracket but no comma), so a simple
 * split usually works — but the double-quote handling is defensive
 * against future format shifts.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Handle escaped double-quote by peeking. Rare in CAMS output but
      // harmless if present.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a CAMS currency cell into a number. Handles all three forms
 * observed in real exports:
 *   "Rs 592172.82"       → 592172.82
 *   "12345.00"           → 12345
 *   "(32.64)"            → -32.64      (parenthesized = negative)
 *   ""                    → 0            (empty cells common in headers)
 * NaN input propagates as 0 to keep downstream sums well-defined; the
 * DIFF layer catches suspicious totals via sum-consistency checks.
 */
function parseCurrency(raw: string): number {
  if (!raw) return 0;
  const trimmed = raw.replace(/rs\.?/i, "").trim();
  if (!trimmed) return 0;
  const isNegative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/^\(|\)$/g, "")
    .replace(/,/g, "")
    .trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return isNegative ? -n : n;
}

/**
 * Parse "DD-MMM-YYYY" (CAMS transaction date format, e.g. "16-Jul-2026")
 * into ISO YYYY-MM-DD. Case-insensitive on the month token. Throws on
 * malformed input so the caller can surface it via CamsParseError.
 */
const MONTH_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function parseCamsDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) throw new CamsParseError("date", `Cannot parse date "${raw}"`);
  const day = m[1].padStart(2, "0");
  const monthKey = m[2].toLowerCase();
  const month = MONTH_ABBR[monthKey];
  if (!month) throw new CamsParseError("date", `Unknown month "${m[2]}" in "${raw}"`);
  return `${m[3]}-${month}-${day}`;
}

/**
 * Parse the statement-date header format: "July 17 2026" or
 * "July 17  2026 01:16 AM". The prefix "Statement Generation Date :" is
 * stripped before this is called. Also handles "on July 17 2026" which
 * appears embedded in the investment-summary column headers.
 */
const MONTH_LONG: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};
function parseStatementDate(raw: string): string {
  const cleaned = raw.replace(/^\s*on\s+/i, "").trim();
  const m = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})/);
  if (!m) throw new CamsParseError("subscriber", `Cannot parse statement date "${raw}"`);
  const month = MONTH_LONG[m[1].toLowerCase()];
  if (!month) throw new CamsParseError("subscriber", `Unknown month "${m[1]}"`);
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

// ─── Scheme name classifier ──────────────────────────────────────────────

function classifySchemeName(name: string): {
  assetClass: SchemeAssetClass;
  variant: SchemeVariant;
  tier: SchemeTier;
} {
  // Asset class — the letter after "SCHEME "
  const assetMatch = name.match(/SCHEME\s+([ECGA])\b/i);
  if (!assetMatch) {
    throw new CamsParseError(
      "schemeSummary",
      `Cannot detect asset class from scheme name "${name}"`
    );
  }
  const assetClass = assetMatch[1].toUpperCase() as SchemeAssetClass;

  // Tier — "TIER I" or "TIER II" (allow hyphens/whitespace between TIER
  // and roman numeral, matching Kotak's naming quirks)
  const tierMatch = name.match(/TIER[\s-]+(II?|I{2})\b/i);
  if (!tierMatch) {
    throw new CamsParseError(
      "schemeSummary",
      `Cannot detect tier from scheme name "${name}"`
    );
  }
  const tierToken = tierMatch[1].toUpperCase();
  const tier: SchemeTier = tierToken === "I" ? "I" : "II";

  // Variant — POP / DIRECT / GS / CORP suffix. Absence = UNKNOWN, which
  // the diff engine treats as a hard validation failure (we want to know
  // exactly which variant the user is invested in).
  let variant: SchemeVariant = "UNKNOWN";
  if (/\bPOP\b/i.test(name)) variant = "POP";
  else if (/\bDIRECT\b/i.test(name)) variant = "DIRECT";
  else if (/\bGS\b/i.test(name)) variant = "GS";
  else if (/\bCORP\b/i.test(name)) variant = "CORP";

  return { assetClass, variant, tier };
}

// ─── Section parsers ─────────────────────────────────────────────────────

/**
 * Extract PRAN, subscriber name, statement date, scheme choice from the
 * "Subscriber Details" section. Format observed:
 *
 *   PRAN,'XXXXXXXXXXXX
 *   Subscriber Name,SUBSCRIBER NAME
 *   Statement Generation Date :July 17  2026 01:16 AM
 *   Scheme Choice - ACTIVE CHOICE
 *
 * Note the mixed separator styles: some fields use commas, others use
 * colons or hyphens. We handle each field independently by pattern
 * matching on the line prefix.
 */
function parseSubscriber(lines: string[]): ParsedCas["subscriber"] {
  let pran = "";
  let name = "";
  let statementDateIso = "";
  let schemeChoice: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // PRAN — accept "PRAN,'XXXXXXXXXXXX" OR "PRAN,XXXXXXXXXXXX" (with or
    // without the apostrophe-prefix). Strip the apostrophe and any
    // stray commas from the value.
    if (/^pran\b/i.test(line)) {
      const parts = splitCsvLine(line);
      const raw = (parts[1] ?? "").replace(/^'/, "").trim();
      // 12-digit numeric check. Allows the parser to reject a truncated
      // paste before we ever hit the DB.
      if (!/^\d{12}$/.test(raw)) {
        throw new CamsParseError(
          "subscriber",
          `PRAN "${raw}" is not 12 digits`,
          "Expected a 12-digit numeric PRAN (all digits, no letters or spaces)."
        );
      }
      pran = raw;
      continue;
    }

    if (/^subscriber\s+name/i.test(line)) {
      const parts = splitCsvLine(line);
      name = (parts[1] ?? "").trim();
      continue;
    }

    // Statement Generation Date has a colon separator (no comma). Match
    // greedily after the colon.
    const stmtMatch = line.match(/^statement\s+generation\s+date\s*:?\s*(.+)$/i);
    if (stmtMatch) {
      // Trailing commas from CSV export are common on this line
      const cleaned = stmtMatch[1].replace(/,+$/, "").trim();
      statementDateIso = parseStatementDate(cleaned);
      continue;
    }

    const choiceMatch = line.match(/^scheme\s+choice\s*[-:]\s*(.+)$/i);
    if (choiceMatch) {
      schemeChoice = choiceMatch[1].replace(/,+$/, "").trim();
      continue;
    }
  }

  if (!pran) {
    throw new CamsParseError("subscriber", "PRAN missing from Subscriber Details section");
  }
  if (!statementDateIso) {
    throw new CamsParseError("subscriber", "Statement Generation Date missing");
  }
  return { pran, name, statementDateIso, schemeChoice };
}

/**
 * Extract the 5-column KPI row from the "Investment Summary" section.
 * Format observed (columns wrap across the header line and the data
 * line — we skip label rows and match numeric-looking rows):
 *
 *   Value of your Holdings ... , No of Contributions , Total Contribution ...
 *   (A) , , (B) , (C) , D=(A-B)+C , E , , ,
 *   Rs 592172.82 , 29 , Rs 555354.28 , Rs 0.00 , Rs 36818.54 , Rs 88.50 , , ,
 *
 * We ignore the label rows (they start with "Value of" or "(A)") and
 * pick the first row whose first cell parses as a currency.
 */
function parseInvestmentSummary(lines: string[]): ParsedCas["investmentSummary"] {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^value\s+of/i.test(line) || /^\(a\)/i.test(line)) continue; // label rows

    const cols = splitCsvLine(line);
    // Sanity: first cell must contain "Rs " to be a data row (skips any
    // stray comment lines).
    if (!/rs/i.test(cols[0] ?? "")) continue;

    return {
      totalValue: parseCurrency(cols[0] ?? ""),
      numContributions: Number(cols[1] ?? 0) || 0,
      totalContribution: parseCurrency(cols[2] ?? ""),
      totalWithdrawal: parseCurrency(cols[3] ?? ""),
      notionalGainLoss: parseCurrency(cols[4] ?? ""),
      intermediaryChargesInr: parseCurrency(cols[5] ?? ""),
    };
  }
  throw new CamsParseError(
    "summary",
    "No numeric data row found in Investment Summary section"
  );
}

/**
 * Extract per-scheme rows from "Investment Details - Scheme Wise Summary":
 *
 *   Particulars , Scheme wise Value ... , Total Units (U) , NAV as on 16-Jul-2026 (N) ,
 *   KOTAK PENSION FUND SCHEME E - TIER I POP , 446505.51 , 6572.2886 , 67.9376 ,
 *   KOTAK PENSION FUND SCHEME C - TIER I POP , ...
 *   KOTAK PENSION FUND SCHEME G - TIER I POP , ...
 */
function parseSchemeSummary(lines: string[]): {
  rows: SchemeSummaryRow[];
  navDateIso: string | null;
} {
  const rows: SchemeSummaryRow[] = [];
  let navDateIso: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Header line: "Particulars,Scheme wise Value...,Total Units (U),NAV as on DD-MMM-YYYY (N),"
    if (/^particulars/i.test(line)) {
      const navHeader = line.match(/nav\s+as\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
      if (navHeader) {
        try {
          navDateIso = parseCamsDate(navHeader[1]);
        } catch {
          // Non-fatal — schemeSummary rows still parse. Diff engine
          // falls back to the statement date if this is null.
          navDateIso = null;
        }
      }
      continue;
    }

    // Data row: starts with scheme name (contains "PENSION FUND SCHEME")
    if (!/pension\s+fund\s+scheme/i.test(line)) continue;

    const cols = splitCsvLine(line);
    if (cols.length < 4) {
      throw new CamsParseError(
        "schemeSummary",
        `Malformed scheme row: "${line}"`
      );
    }
    const fullName = cols[0];
    const classified = classifySchemeName(fullName);
    rows.push({
      fullName,
      assetClass: classified.assetClass,
      variant: classified.variant,
      tier: classified.tier,
      value: parseCurrency(cols[1]),
      units: parseCurrency(cols[2]),
      nav: parseCurrency(cols[3]),
      navDateIso,
    });
  }

  if (rows.length === 0) {
    throw new CamsParseError(
      "schemeSummary",
      "No scheme rows found in Investment Details section"
    );
  }
  return { rows, navDateIso };
}

/**
 * Extract contribution/redemption rows. Format:
 *
 *   Date , Particulars , Uploaded By , Employee Contribution , Employer's Contribution , Total(Rs) ,
 *   09-Apr-2026 , By Arrear - Regular contribution of March , Kotak Mahindra Bank Limited (5000041) , 0.00 , 15076.00 , 15076.00 ,
 *   16-Jul-2026 , By Voluntary Contributions , ... , 88.95 , 0.00 , 88.95 ,
 *
 * Categorization:
 *   • Particulars starts with "By Arrear - Regular contribution" → payroll
 *   • Particulars is exactly "By Voluntary Contributions"        → voluntary
 *   • Anything else                                              → internal
 *     (In practice CAMS keeps SPC/billing OUT of this section — they only
 *      appear in per-scheme Transaction Details. But we keep the internal
 *      bucket as a safety net for future format changes.)
 */
function parseContributions(lines: string[]): ContributionRow[] {
  const rows: ContributionRow[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^date\s*,/i.test(line)) continue; // header row

    const cols = splitCsvLine(line);
    // Data row must start with a valid CAMS date
    if (!/^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(cols[0] ?? "")) continue;

    const dateIso = parseCamsDate(cols[0]);
    const particulars = cols[1] ?? "";
    const uploadedBy = cols[2] ?? "";
    const employee = parseCurrency(cols[3] ?? "");
    const employer = parseCurrency(cols[4] ?? "");
    const total = parseCurrency(cols[5] ?? "");

    // Categorize by particulars text. The regex accepts both hyphen
    // ("By Arrear - Regular") and en-dash variants in case CAMS ever
    // switches punctuation.
    let category: ContributionRow["category"];
    if (/^by\s+arrear\s*[-–—]\s*regular\s+contribution/i.test(particulars)) {
      category = "payroll";
    } else if (/^by\s+voluntary\s+contribution/i.test(particulars)) {
      category = "voluntary";
    } else {
      category = "internal";
    }

    rows.push({
      dateIso,
      particulars,
      uploadedBy,
      employeeContribution: employee,
      employerContribution: employer,
      total,
      category,
    });
  }

  return rows;
}

// ─── Public entry point ──────────────────────────────────────────────────

export function parseCamsCsv(csv: string): ParsedCas {
  if (typeof csv !== "string" || !csv.trim()) {
    throw new CamsParseError("input", "Empty CSV input");
  }

  const lines = csv.replace(/\r\n/g, "\n").split("\n");

  // Partition the file into per-section line arrays. The header section
  // is discarded; other sections get their own accumulator.
  const bySection: Record<SectionKey, string[]> = {
    header: [],
    subscriber: [],
    summary: [],
    schemeSummary: [],
    contribution: [],
    transaction: [],
    unknown: [],
  };

  let current: SectionKey = "unknown";
  for (const line of lines) {
    const detected = detectSection(line);
    if (detected) {
      current = detected;
      continue; // don't include the header line itself in the section body
    }
    bySection[current].push(line);
  }

  // Sanity: the file has to look like a CAMS statement or we bail early
  // with a clear error rather than parsing garbage into a valid-looking
  // ParsedCas with empty sections.
  if (
    bySection.subscriber.length === 0 &&
    bySection.summary.length === 0 &&
    bySection.schemeSummary.length === 0
  ) {
    throw new CamsParseError(
      "input",
      "This does not look like a CAMS NPS Transaction Statement CSV",
      "Download from services.camsnps.in → Transaction Statement → export as CSV, then paste the full file including the 'NPS Transaction Statement' header row."
    );
  }

  const subscriber = parseSubscriber(bySection.subscriber);
  const investmentSummary = parseInvestmentSummary(bySection.summary);
  const schemeSummary = parseSchemeSummary(bySection.schemeSummary);
  const contributions = parseContributions(bySection.contribution);

  // Roll-up computeds — used by the diff engine's sum-consistency
  // validation and by the preview UI.
  const sumOfSchemeValues = schemeSummary.rows.reduce(
    (s, r) => s + r.value,
    0
  );
  const payrollTotal = contributions
    .filter((c) => c.category === "payroll")
    .reduce((s, c) => s + c.total, 0);
  const voluntaryTotal = contributions
    .filter((c) => c.category === "voluntary")
    .reduce((s, c) => s + c.total, 0);

  return {
    raw: {
      charCount: csv.length,
      lineCount: lines.length,
    },
    subscriber,
    investmentSummary,
    schemeSummary: schemeSummary.rows,
    contributions,
    computed: {
      sumOfSchemeValues,
      payrollTotal,
      voluntaryTotal,
    },
  };
}
