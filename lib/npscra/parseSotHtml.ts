/**
 * Protean CRA "Statement of Transactions" (SOT) HTML parser.
 *
 * The user pastes the raw HTML of an annual FY statement from
 *   https://cra.nps-proteantech.in/CRA/JSP/common/SOTView.jsp
 * We extract the transactions block (per-scheme, dated, with NAV +
 * units) and drop everything else — no PII (PRAN, name, address,
 * mobile, email, PoP/CBO/CHO detail) is stored in the DB.
 *
 * PARSER STRATEGY
 * ───────────────
 * The transactions block is a repeating pattern:
 *
 *   <table class="... trsnDtlnew1">
 *     <td>KOTAK PENSION FUND SCHEME E - TIER I POP</td>   ← scheme header
 *   </table>
 *   <table class="... trsnDtlnew2">
 *     <tr>Date | Description | Amount | NAV | Units</tr>  ← column header
 *     <tr>01-Apr-2024 | Opening balance | | | 0.0000</tr>
 *     <tr>10-Apr-2024 | By Arrear - ... | 1,35,312.89 | 59.7091 | 2,266.2021</tr>
 *     ...
 *     <tr>31-Mar-2025 | Closing Balance | | | 3,905.1712</tr>
 *   </table>
 *
 * We select the two classes in DOM order and pair them up (nth
 * trsnDtlnew1 header → nth trsnDtlnew2 body). The current statement
 * has one pair per active scheme (3 for the user's E/C/G Active Choice).
 *
 * The contribution/redemption aggregate table (id="contrdtltable")
 * carries the "Uploaded By" bank/branch for each credit event, which
 * we cross-reference back into per-scheme rows for provenance.
 *
 * INDIAN NUMBER FORMAT
 * ────────────────────
 * All amounts use Indian lakh grouping ("1,80,417.19") and parentheses
 * for negatives ("(37.62)" = -37.62). Both handled by parseIndianNumber.
 *
 * DATE FORMAT
 * ───────────
 * CRA uses "DD-Mon-YYYY" ("10-Apr-2024"). Mapped to ISO YYYY-MM-DD
 * so downstream queries and the Postgres `date` column consume it
 * without further coercion.
 */

import { parse, HTMLElement } from "node-html-parser";
import { createHash } from "crypto";
import {
  classifyNpsTxType,
  classifyContributionSide,
  type NpsTxType,
} from "./classifyTx";

// ─── Public types ──────────────────────────────────────────────────

export type NpsTier = "I" | "II" | "TTS";
export type NpsScheme = "E" | "C" | "G" | "A";

export type NpsSotTx = {
  /** Position within the source file — stable across re-parses. */
  source_row_idx: number;
  /** md5 idempotency key including dupeSeq disambiguation. */
  tx_hash: string;

  tx_date: string;              // YYYY-MM-DD
  fy: string;                   // "2024-25" style
  tier: NpsTier;
  scheme: NpsScheme;
  tx_type: NpsTxType;

  amount: number;               // Signed. Negative for billing / debits.
  nav: number | null;
  units: number | null;         // Signed to match amount direction.

  description_raw: string;
  uploaded_by: string | null;   // e.g. "Kotak Mahindra Bank Limited (5000041)"
  contribution_side: "employer" | "employee" | "voluntary" | null;

  scheme_name_raw: string;      // Full "KOTAK PENSION FUND SCHEME E - TIER I POP"
};

export type NpsSotAggregate = {
  tx_date: string;
  description: string;
  uploaded_by: string;
  employee_amount: number;
  employer_amount: number;
  total_amount: number;
};

export type NpsSchemeSummary = {
  scheme: NpsScheme;
  tier: NpsTier;
  scheme_name_raw: string;
  opening_units: number;
  closing_units: number;
  tx_count: number;                     // total rows (contribs + billing)
  contribution_count: number;
  contribution_amount: number;
  billing_count: number;
  billing_amount: number;
  /** Sum of signed units in this block — should equal closing - opening. */
  net_units_delta: number;
};

export type ParsedNpsSot = {
  fy: string;                           // "2024-25"
  period: { from: string; to: string }; // ISO dates
  schemes: NpsSchemeSummary[];
  transactions: NpsSotTx[];
  aggregate_contributions: NpsSotAggregate[];
  totals: {
    total_rows: number;
    contribution_count: number;
    contribution_amount: number;
    billing_count: number;
    billing_amount: number;
  };
  warnings: string[];                   // Non-fatal parse anomalies
};

// ─── Number / date parsing ─────────────────────────────────────────

/**
 * Parse a CRA amount cell → number.
 *
 * Handles:
 *   "1,80,417.19"   → 180417.19   (Indian lakh grouping)
 *   "(37.62)"       → -37.62      (parentheses = negative)
 *   "-25.65"        → -25.65      (explicit minus)
 *   "&nbsp;" / ""   → NaN         (caller distinguishes via caller)
 */
function parseIndianNumber(raw: string): number {
  if (!raw) return NaN;
  const trimmed = raw.replace(/\u00a0/g, " ").trim(); // strip nbsp
  if (!trimmed || trimmed === "-") return NaN;
  // Parentheses convention: "(37.62)" → -37.62
  const parenMatch = /^\(\s*(.+?)\s*\)$/.exec(trimmed);
  const numericSource = parenMatch ? parenMatch[1] : trimmed;
  const sign = parenMatch ? -1 : 1;
  // Strip commas (any grouping, lakh or thousand style)
  const cleaned = numericSource.replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? sign * n : NaN;
}

/** "10-Apr-2024" → "2024-04-10". Returns null if unparseable. */
function parseDdMmmYyyy(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(trimmed);
  if (!m) return null;
  const MONTHS: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

/** "April 01, 2024" → "2024-04-01". Used for the statement-period header. */
function parseLongDate(raw: string): string | null {
  if (!raw) return null;
  const m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const MONTHS: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const mm = MONTHS[m[1].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, "0")}`;
}

/**
 * Derive Indian FY string from an ISO date.
 *   2024-04-01 → "2024-25"
 *   2025-03-31 → "2024-25"
 *   2025-04-01 → "2025-26"
 * FY runs Apr 1 → Mar 31.
 */
function deriveFy(fromDate: string): string {
  const [yStr, mStr] = fromDate.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const fyStart = m >= 4 ? y : y - 1;
  const fyEndSuffix = String((fyStart + 1) % 100).padStart(2, "0");
  return `${fyStart}-${fyEndSuffix}`;
}

// ─── Scheme name → (scheme letter, tier) ───────────────────────────

/**
 * Extract scheme letter + tier from a full scheme name like
 * "KOTAK PENSION FUND SCHEME E - TIER I POP".
 *
 * Regex-driven so it survives PFM changes ("KOTAK" → "SBI" etc.).
 * Order matters: TIER II must test before TIER I because "TIER II"
 * substring-contains "TIER I".
 */
function parseSchemeName(
  raw: string
): { scheme: NpsScheme | null; tier: NpsTier | null } {
  const upper = raw.toUpperCase();

  // Scheme letter: "SCHEME [ECGA]"
  const schemeMatch = /\bSCHEME\s+([ECGA])\b/.exec(upper);
  const scheme: NpsScheme | null = schemeMatch
    ? (schemeMatch[1] as NpsScheme)
    : null;

  // Tier: check TIER II before TIER I (substring safety)
  let tier: NpsTier | null = null;
  if (/\bTIER\s+II\b/.test(upper) || /\bTIER-?2\b/.test(upper)) {
    tier = "II";
  } else if (/\bTIER\s+I\b/.test(upper) || /\bTIER-?1\b/.test(upper)) {
    tier = "I";
  } else if (/\bTTS\b/.test(upper)) {
    tier = "TTS";
  }

  return { scheme, tier };
}

// ─── Text extraction helpers ───────────────────────────────────────

function cellText(td: HTMLElement | null | undefined): string {
  if (!td) return "";
  return td.textContent.replace(/\u00a0/g, " ").trim();
}

/** Grab the period text from the SOT header — used to derive FY. */
function extractPeriod(root: HTMLElement): {
  from: string;
  to: string;
} | null {
  // The period sits inside a td#stddate near the top:
  //   <span>April 01, 2024</span> to <span>March 31, 2025</span>
  const stddate = root.querySelector("#stddate");
  if (!stddate) return null;
  const spans = stddate.querySelectorAll("span");
  // First two spans are the from / to; a third exists but holds the
  // statement generation datetime.
  if (spans.length < 2) return null;
  const from = parseLongDate(cellText(spans[0]));
  const to = parseLongDate(cellText(spans[1]));
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Parse the contribution/redemption aggregate table.
 *
 * This is the summary-level view (one row per credit event) that also
 * carries "Uploaded By" — the bank/branch that wired the money. We
 * cross-reference this into per-scheme rows for provenance.
 *
 * Table shape (see the FY24-25 fixture):
 *   <table id="contrdtltable">
 *     ... 2 header rows (colspan-based, ignored)
 *     ... 1 sub-header row (Employee / Employer / Total labels)
 *     ... N data rows: Date | Particulars | Uploaded By | Emp | Empr | Total
 *   </table>
 *
 * The HTML is mildly malformed (data rows live outside <tbody> in
 * places) but node-html-parser flattens that during querySelector.
 */
function extractAggregate(root: HTMLElement): NpsSotAggregate[] {
  const table = root.querySelector("#contrdtltable");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out: NpsSotAggregate[] = [];
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 6) continue;
    // Data row shape: 6 cells with date-looking first cell.
    const dateIso = parseDdMmmYyyy(cellText(tds[0]));
    if (!dateIso) continue;
    const desc = cellText(tds[1]);
    const uploader = cellText(tds[2]).replace(/,\s*$/, ""); // strip trailing ","
    const employee = parseIndianNumber(cellText(tds[3]));
    const employer = parseIndianNumber(cellText(tds[4]));
    const total = parseIndianNumber(cellText(tds[5]));
    if (!Number.isFinite(total)) continue;
    out.push({
      tx_date: dateIso,
      description: desc,
      uploaded_by: uploader,
      employee_amount: Number.isFinite(employee) ? employee : 0,
      employer_amount: Number.isFinite(employer) ? employer : 0,
      total_amount: total,
    });
  }
  return out;
}

// ─── Per-scheme transaction extractor ──────────────────────────────

/**
 * Walk the `.trsnDtlnew1` / `.trsnDtlnew2` pairs and yield one
 * intermediate row per parsed transaction. The caller enriches
 * uploaded_by and computes tx_hashes in a second pass.
 */
type IntermediateTx = Omit<NpsSotTx, "tx_hash" | "fy" | "uploaded_by"> & {
  is_opening: boolean;
  is_closing: boolean;
};

function extractSchemeBlocks(
  root: HTMLElement,
  warnings: string[]
): {
  intermediate: IntermediateTx[];
  perScheme: Map<string, { opening: number; closing: number; name: string }>;
} {
  const headers = root.querySelectorAll(".trsnDtlnew1");
  const bodies = root.querySelectorAll(".trsnDtlnew2");

  if (headers.length !== bodies.length) {
    warnings.push(
      `Expected .trsnDtlnew1 count (${headers.length}) to match .trsnDtlnew2 count (${bodies.length}) — parsing what we can.`
    );
  }

  const pairCount = Math.min(headers.length, bodies.length);
  const intermediate: IntermediateTx[] = [];
  const perScheme = new Map<
    string,
    { opening: number; closing: number; name: string }
  >();
  let globalRowIdx = 0;

  for (let i = 0; i < pairCount; i++) {
    const headerEl = headers[i];
    const bodyEl = bodies[i];
    const schemeNameRaw = cellText(headerEl.querySelector("td"));
    const { scheme, tier } = parseSchemeName(schemeNameRaw);
    if (!scheme || !tier) {
      warnings.push(
        `Skipped unrecognised scheme name: "${schemeNameRaw}" — expected e.g. "KOTAK PENSION FUND SCHEME E - TIER I POP"`
      );
      continue;
    }

    const key = `${tier}:${scheme}`;
    let opening = 0;
    let closing = 0;

    const rows = bodyEl.querySelectorAll("tr");
    for (const tr of rows) {
      const tds = tr.querySelectorAll("td");
      // Expected column shape: Date | Description | Amount | NAV | Units
      if (tds.length !== 5) continue;

      const dateCell = cellText(tds[0]);
      const desc = cellText(tds[1]);
      const amountRaw = cellText(tds[2]);
      const navRaw = cellText(tds[3]);
      const unitsRaw = cellText(tds[4]);

      // Header row of the sub-table: "Date | Description | ..."
      if (/^date$/i.test(dateCell)) continue;

      const isoDate = parseDdMmmYyyy(dateCell);
      if (!isoDate) continue;

      const descLower = desc.toLowerCase();
      const isOpening = descLower === "opening balance";
      const isClosing = descLower === "closing balance";

      const units = parseIndianNumber(unitsRaw);

      if (isOpening) {
        opening = Number.isFinite(units) ? units : 0;
        continue;
      }
      if (isClosing) {
        closing = Number.isFinite(units) ? units : 0;
        continue;
      }

      const amount = parseIndianNumber(amountRaw);
      const nav = parseIndianNumber(navRaw);
      if (!Number.isFinite(amount)) {
        warnings.push(
          `Row skipped — unparseable amount on ${isoDate} ${scheme}: "${amountRaw}"`
        );
        continue;
      }

      const tx_type = classifyNpsTxType(desc, amount);

      intermediate.push({
        source_row_idx: globalRowIdx++,
        tx_date: isoDate,
        tier,
        scheme,
        tx_type,
        amount,
        nav: Number.isFinite(nav) ? nav : null,
        units: Number.isFinite(units) ? units : null,
        description_raw: desc,
        contribution_side: classifyContributionSide(desc, null, tx_type),
        scheme_name_raw: schemeNameRaw,
        is_opening: false,
        is_closing: false,
      });
    }

    perScheme.set(key, { opening, closing, name: schemeNameRaw });
  }

  return { intermediate, perScheme };
}

// ─── Hash + enrichment passes ──────────────────────────────────────

/**
 * Enrich each transaction with the `uploaded_by` bank/branch from the
 * aggregate contribution table (matched by tx_date). Billing / switch
 * / withdrawal rows don't appear in the aggregate table, so they keep
 * uploaded_by = null.
 *
 * If multiple aggregate rows share a date (rare — e.g., an employer
 * arrear + an employee voluntary top-up posted the same day), we pick
 * the first — same-date collisions are informational only, the truth
 * remains on the per-scheme row.
 */
function enrichUploadedBy(
  intermediate: IntermediateTx[],
  aggregate: NpsSotAggregate[]
): (IntermediateTx & { uploaded_by: string | null })[] {
  const byDate = new Map<string, string>();
  for (const a of aggregate) {
    if (!byDate.has(a.tx_date)) byDate.set(a.tx_date, a.uploaded_by);
  }
  return intermediate.map((t) => ({
    ...t,
    uploaded_by:
      t.tx_type === "contribution" ? byDate.get(t.tx_date) ?? null : null,
  }));
}

/**
 * Deterministic idempotency hash — md5 of the joined transaction
 * fingerprint (FY, tier, scheme, date, type, amount, units, description).
 *
 * `dupeSeq` fires only when two rows would otherwise hash identically
 * within the same file. For NPS SOT this is rare (billing rows on the
 * same day for the same scheme differ in amount / description). We
 * carry the disambiguator anyway for defence-in-depth: if a future
 * CRA statement ever emits two truly-identical rows we won't silently
 * collapse them into one on upsert.
 */
function computeTxHash(parts: {
  fy: string;
  tier: NpsTier;
  scheme: NpsScheme;
  tx_date: string;
  tx_type: NpsTxType;
  amount: number;
  units: number | null;
  desc: string;
  dupeSeq: number;
}): string {
  const base = [
    parts.fy,
    parts.tier,
    parts.scheme,
    parts.tx_date,
    parts.tx_type,
    parts.amount.toFixed(4),
    (parts.units ?? 0).toFixed(4),
    parts.desc,
  ].join("|");
  const key = parts.dupeSeq > 1 ? `${base}|#${parts.dupeSeq}` : base;
  return createHash("md5").update(key).digest("hex");
}

// ─── Main entry point ──────────────────────────────────────────────

/**
 * Parse a Protean CRA SOT HTML string. Never throws on malformed rows;
 * anomalies land in `warnings` and are surfaced in the preview UI.
 * The one hard error is unrecognised statement shape (no period, or
 * zero scheme blocks) — those are 400s at the API layer.
 */
export function parseSotHtml(html: string): ParsedNpsSot {
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
  });
  const warnings: string[] = [];

  // ── Statement period → FY ────────────────────────────────────
  const period = extractPeriod(root);
  if (!period) {
    throw new Error(
      "Could not locate statement period in SOT HTML. Expected a #stddate block with two dates like 'April 01, 2024' to 'March 31, 2025'."
    );
  }
  const fy = deriveFy(period.from);

  // ── Aggregate credits table (for uploaded_by enrichment) ─────
  const aggregate = extractAggregate(root);

  // ── Per-scheme transaction blocks ────────────────────────────
  const { intermediate, perScheme } = extractSchemeBlocks(root, warnings);
  if (intermediate.length === 0) {
    throw new Error(
      "No transactions found in SOT HTML. Expected one or more '.trsnDtlnew1' + '.trsnDtlnew2' pairs describing E/C/G schemes."
    );
  }

  // ── Enrich with uploaded_by ──────────────────────────────────
  const enriched = enrichUploadedBy(intermediate, aggregate);

  // ── Compute tx_hashes with dupeSeq disambiguation ────────────
  // Traversal order is source order, so seq assignment is stable
  // across re-uploads.
  const baseCounts = new Map<string, number>();
  const transactions: NpsSotTx[] = enriched.map((t) => {
    const base = [
      fy,
      t.tier,
      t.scheme,
      t.tx_date,
      t.tx_type,
      t.amount.toFixed(4),
      (t.units ?? 0).toFixed(4),
      t.description_raw,
    ].join("|");
    const seenSoFar = baseCounts.get(base) ?? 0;
    const dupeSeq = seenSoFar + 1;
    baseCounts.set(base, dupeSeq);
    return {
      source_row_idx: t.source_row_idx,
      tx_hash: computeTxHash({
        fy,
        tier: t.tier,
        scheme: t.scheme,
        tx_date: t.tx_date,
        tx_type: t.tx_type,
        amount: t.amount,
        units: t.units,
        desc: t.description_raw,
        dupeSeq,
      }),
      tx_date: t.tx_date,
      fy,
      tier: t.tier,
      scheme: t.scheme,
      tx_type: t.tx_type,
      amount: t.amount,
      nav: t.nav,
      units: t.units,
      description_raw: t.description_raw,
      uploaded_by: t.uploaded_by,
      contribution_side: t.contribution_side,
      scheme_name_raw: t.scheme_name_raw,
    };
  });

  // ── Per-scheme summary + reconciliation ──────────────────────
  const schemes: NpsSchemeSummary[] = [];
  for (const [key, meta] of perScheme.entries()) {
    const [tier, scheme] = key.split(":") as [NpsTier, NpsScheme];
    const rows = transactions.filter(
      (t) => t.tier === tier && t.scheme === scheme
    );
    const contribs = rows.filter((r) => r.tx_type === "contribution");
    const billings = rows.filter((r) => r.tx_type === "billing");
    const netUnitsDelta = rows.reduce((sum, r) => sum + (r.units ?? 0), 0);
    schemes.push({
      scheme,
      tier,
      scheme_name_raw: meta.name,
      opening_units: meta.opening,
      closing_units: meta.closing,
      tx_count: rows.length,
      contribution_count: contribs.length,
      contribution_amount: contribs.reduce((s, r) => s + r.amount, 0),
      billing_count: billings.length,
      billing_amount: billings.reduce((s, r) => s + r.amount, 0),
      net_units_delta: netUnitsDelta,
    });
  }

  // ── Aggregate totals across all schemes ──────────────────────
  const totals = {
    total_rows: transactions.length,
    contribution_count: transactions.filter((t) => t.tx_type === "contribution")
      .length,
    contribution_amount: transactions
      .filter((t) => t.tx_type === "contribution")
      .reduce((s, t) => s + t.amount, 0),
    billing_count: transactions.filter((t) => t.tx_type === "billing").length,
    billing_amount: transactions
      .filter((t) => t.tx_type === "billing")
      .reduce((s, t) => s + t.amount, 0),
  };

  return {
    fy,
    period,
    schemes,
    transactions,
    aggregate_contributions: aggregate,
    totals,
    warnings,
  };
}
