/**
 * CAS reconciliation diff engine.
 *
 * Given a parsed CAMS CSV (see camsParser.ts) plus a snapshot of live DB
 * state (nps_state + retirement_credits filtered to source='NPS'), this
 * module produces a fully structured "what will change" report. The
 * preview API route serves it verbatim; the apply route rebuilds it
 * against fresh DB state before executing.
 *
 * DESIGN INVARIANTS
 * -----------------
 * 1. Deterministic: same inputs → same output, no wall-clock reads.
 * 2. Zero side effects: pure computation, safe to call in a loop.
 * 3. Human-readable: every classification carries enough context for
 *    the UI to explain WHY a row was flagged (e.g., "ledger has Jul 8
 *    but CAS has Jul 6" is spelled out as `ledgerRow` on the event).
 *
 * FOUR-STATUS CLASSIFIER FOR PAYROLL EVENTS
 * -----------------------------------------
 *   new              — no ledger row with matching (source, credit_date,
 *                       credit_type). Will INSERT.
 *   exact_duplicate  — ledger has same triple + same amount ± ₹1 rounding.
 *                       Will SKIP silently.
 *   amount_mismatch  — same triple, different amount. Preview flags it;
 *                       default action is "overwrite ledger with CSV
 *                       amount" (CAS is authoritative).
 *   near_duplicate   — no exact triple match, but there's a ledger row
 *                       with (source, ±3 days, credit_type) and matching
 *                       amount ± ₹1. Preview flags it; default action is
 *                       "replace ledger row (delete old, insert new
 *                       with CAS date)".
 *
 * Additional categorical statuses:
 *   skipped_voluntary  — voluntary contribution rows; per user's Jul 17
 *                         decision these are baked into total_invested_inr
 *                         directly instead of being ledger events.
 *   skipped_internal   — SPC/billing/opening/closing balance rows. Not
 *                         in the "Contribution/Redemption Details"
 *                         section on real CAMS exports but kept as a
 *                         safety catch.
 */

import type { ContributionRow, ParsedCas, SchemeSummaryRow } from "./camsParser";

// ─── Types the preview & apply routes consume ────────────────────────────

export type NpsStateSnapshot = {
  pran: string | null;
  scheme_e_units: number;
  scheme_c_units: number;
  scheme_g_units: number;
  scheme_e_nav: number;
  scheme_c_nav: number;
  scheme_g_nav: number;
  total_invested_inr: number;
  nav_date: string | null;
};

export type LedgerRowSnapshot = {
  id: number;
  credit_date: string;      // ISO
  credit_type: "payroll" | "interest" | "self";
  amount_inr: number;
  note: string | null;
};

export type EventStatus =
  | "new"
  | "exact_duplicate"
  | "amount_mismatch"
  | "near_duplicate"
  | "skipped_voluntary"
  | "skipped_internal";

/**
 * A single classified CSV row, ready for UI rendering + apply decisions.
 * `csv` is always present. `ledgerMatch` is populated for the three
 * statuses where a ledger row is involved (exact_duplicate,
 * amount_mismatch, near_duplicate).
 */
export type ClassifiedEvent = {
  key: string;              // stable identifier for the UI checkbox
  status: EventStatus;
  csv: {
    dateIso: string;
    amountInr: number;
    creditType: "payroll" | "interest"; // 'interest' never appears from CAS but
                                        // typed for future-proofing
    particulars: string;
    category: ContributionRow["category"];
  };
  ledgerMatch: LedgerRowSnapshot | null;
  daysApart: number | null;  // populated on near_duplicate
  amountDelta: number | null; // populated on amount_mismatch (csv - ledger)
  reason: string;             // human-readable explanation for the UI
};

export type StateFieldDiff<T> = {
  current: T;
  proposed: T;
  changed: boolean;
};

export type StateDiff = {
  scheme_e_units: StateFieldDiff<number>;
  scheme_c_units: StateFieldDiff<number>;
  scheme_g_units: StateFieldDiff<number>;
  scheme_e_nav: StateFieldDiff<number>;
  scheme_c_nav: StateFieldDiff<number>;
  scheme_g_nav: StateFieldDiff<number>;
  total_invested_inr: StateFieldDiff<number>;
  nav_date: StateFieldDiff<string | null>;
  anyChanged: boolean;
};

export type Validation = {
  pranMatches: boolean;
  pranCurrent: string | null;
  pranFromCsv: string;
  variantIsPop: boolean;
  variantsFound: string[]; // e.g. ["POP","POP","POP"] — for error message
  tierIsOne: boolean;
  sumChecksPass: boolean;
  sumComputed: number;    // sum of scheme (units × NAV)
  sumDeclared: number;    // CSV's "Total Value"
  sumTolerance: number;   // absolute ₹ tolerance used
  // Monotonicity check: CSV's NAV date must be >= DB's stored nav_date.
  // Compared on NAV date (Jul 16), not statement date (Jul 17), so a
  // repeat paste of the same CAS doesn't regress and a fresher Kotak
  // refresh doesn't get incorrectly blocked as "already fresh". See
  // 2026-07-17 discussion for context.
  navDateNotRegressing: boolean;
  navDate: string;        // CSV's actual NAV date (from "NAV as on X" header)
  statementDate: string;  // CSV's Statement Generation Date (audit only)
  dbNavDate: string | null;
};

export type CasDiff = {
  parsed: {
    pran: string;
    // NAV date (Jul 16 for a Jul 17 statement) — this is what's written
    // to nps_state.nav_date so it aligns with Kotak/npsnav.in refresh
    // semantics.
    navDate: string;
    // Statement Generation Date — audit only, shown to the user in the
    // subscriber banner. NOT stored on nps_state.
    statementDate: string;
    subscriberName: string;
    schemeChoice: string | null;
  };
  validation: Validation;
  stateDiff: StateDiff;
  events: ClassifiedEvent[];
  summary: {
    new: number;
    exact_duplicate: number;
    amount_mismatch: number;
    near_duplicate: number;
    skipped_voluntary: number;
    skipped_internal: number;
    voluntaryTotalInr: number;   // Σ voluntary amounts (baked into invested)
    payrollTotalInr: number;     // Σ payroll amounts (for cross-check)
  };
  // A hard-fail flag: if true, the /apply route must refuse to run
  // regardless of what the client sends (defense in depth). Preview UI
  // hides the Apply button in this case.
  fatal: boolean;
  fatalReasons: string[];
};

// ─── Tolerances ──────────────────────────────────────────────────────────
// Rounding-noise thresholds for classifying "same" values. Currency
// amounts on CAMS are typed to 2dp, but rounding of split-scheme totals
// can produce ±₹0.03 drift on aggregated payroll (₹15,076 splits
// 11307/3015.20/753.80, sums to 15076.00 exactly, but per-scheme NAV
// rounding at the 4dp level can introduce sub-rupee wobble on cross-
// checks). Using ₹1 as the tolerance keeps false-positive amount_
// mismatches near zero without allowing genuine "different amount"
// events (typical minimum: ₹100) to slip through as exact matches.

const AMOUNT_EQ_TOLERANCE_INR = 1;
const SUM_CHECK_TOLERANCE_INR = 5; // 3-scheme (u×N) rounding can drift a few rupees
const NEAR_DUP_WINDOW_DAYS = 3;

// ─── Utility ─────────────────────────────────────────────────────────────

function daysBetween(iso1: string, iso2: string): number {
  const t1 = new Date(iso1 + "T00:00:00Z").getTime();
  const t2 = new Date(iso2 + "T00:00:00Z").getTime();
  return Math.abs(Math.round((t1 - t2) / 86400000));
}

function pickScheme(
  rows: SchemeSummaryRow[],
  asset: "E" | "C" | "G"
): SchemeSummaryRow | null {
  return rows.find((r) => r.assetClass === asset && r.tier === "I") ?? null;
}

// ─── State diff ──────────────────────────────────────────────────────────

/**
 * Build the field-by-field state diff. Rounding tolerance for numeric
 * changed-flags is ₹0.005 for currency (so any true value change of ≥
 * ₹0.01 flags as changed; identical values below that are noise). For
 * units and NAVs which are stored to 4dp, the flag uses ε = 0.00005.
 */
function computeStateDiff(current: NpsStateSnapshot, parsed: ParsedCas): StateDiff {
  const e = pickScheme(parsed.schemeSummary, "E");
  const c = pickScheme(parsed.schemeSummary, "C");
  const g = pickScheme(parsed.schemeSummary, "G");
  const eps4 = 0.00005;
  const eps2 = 0.005;

  const mk = <T>(current: T, proposed: T, changed: boolean): StateFieldDiff<T> => ({
    current,
    proposed,
    changed,
  });

  const scheme_e_units = mk(
    current.scheme_e_units,
    e?.units ?? current.scheme_e_units,
    e ? Math.abs(current.scheme_e_units - e.units) > eps4 : false
  );
  const scheme_c_units = mk(
    current.scheme_c_units,
    c?.units ?? current.scheme_c_units,
    c ? Math.abs(current.scheme_c_units - c.units) > eps4 : false
  );
  const scheme_g_units = mk(
    current.scheme_g_units,
    g?.units ?? current.scheme_g_units,
    g ? Math.abs(current.scheme_g_units - g.units) > eps4 : false
  );
  const scheme_e_nav = mk(
    current.scheme_e_nav,
    e?.nav ?? current.scheme_e_nav,
    e ? Math.abs(current.scheme_e_nav - e.nav) > eps4 : false
  );
  const scheme_c_nav = mk(
    current.scheme_c_nav,
    c?.nav ?? current.scheme_c_nav,
    c ? Math.abs(current.scheme_c_nav - c.nav) > eps4 : false
  );
  const scheme_g_nav = mk(
    current.scheme_g_nav,
    g?.nav ?? current.scheme_g_nav,
    g ? Math.abs(current.scheme_g_nav - g.nav) > eps4 : false
  );

  const proposedTotal = parsed.investmentSummary.totalContribution;
  const total_invested_inr = mk(
    current.total_invested_inr,
    proposedTotal,
    Math.abs(current.total_invested_inr - proposedTotal) > eps2
  );

  // nav_date semantic: the day the NAVs actually correspond to (Jul 16
  // for a Jul 17 statement — CAMS prints statements the morning after
  // the close). This aligns with how Kotak's API and npsnav.in fill
  // this field, so downstream refresh calls can compare dates correctly
  // and produce accurate 1D deltas. Fall back to statement date only if
  // the scheme summary header didn't carry a parseable "NAV as on X".
  const navDate =
    parsed.schemeSummary[0]?.navDateIso ?? parsed.subscriber.statementDateIso;
  const nav_date = mk<string | null>(
    current.nav_date,
    navDate,
    current.nav_date !== navDate
  );

  const anyChanged =
    scheme_e_units.changed ||
    scheme_c_units.changed ||
    scheme_g_units.changed ||
    scheme_e_nav.changed ||
    scheme_c_nav.changed ||
    scheme_g_nav.changed ||
    total_invested_inr.changed ||
    nav_date.changed;

  return {
    scheme_e_units,
    scheme_c_units,
    scheme_g_units,
    scheme_e_nav,
    scheme_c_nav,
    scheme_g_nav,
    total_invested_inr,
    nav_date,
    anyChanged,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────

function validate(
  current: NpsStateSnapshot,
  parsed: ParsedCas
): Validation {
  const variantsFound = parsed.schemeSummary.map((r) => r.variant);
  const variantIsPop =
    parsed.schemeSummary.length > 0 &&
    parsed.schemeSummary.every((r) => r.variant === "POP");
  const tierIsOne =
    parsed.schemeSummary.length > 0 &&
    parsed.schemeSummary.every((r) => r.tier === "I");

  const pranMatches =
    current.pran == null ? true : current.pran === parsed.subscriber.pran;

  const sumComputed = parsed.computed.sumOfSchemeValues;
  const sumDeclared = parsed.investmentSummary.totalValue;
  const sumChecksPass =
    Math.abs(sumComputed - sumDeclared) <= SUM_CHECK_TOLERANCE_INR;

  // NAV-date regression: allow equal (repeat paste of the same
  // statement or same-day CAS) but forbid strictly older. Applies only
  // when we have an existing nav_date to compare against. Uses the
  // CSV's NAV date (not statement date) so downstream refresh
  // comparisons stay consistent.
  const navDate =
    parsed.schemeSummary[0]?.navDateIso ?? parsed.subscriber.statementDateIso;
  const navDateNotRegressing =
    current.nav_date == null || navDate >= current.nav_date;

  return {
    pranMatches,
    pranCurrent: current.pran,
    pranFromCsv: parsed.subscriber.pran,
    variantIsPop,
    variantsFound,
    tierIsOne,
    sumChecksPass,
    sumComputed,
    sumDeclared,
    sumTolerance: SUM_CHECK_TOLERANCE_INR,
    navDateNotRegressing,
    navDate,
    statementDate: parsed.subscriber.statementDateIso,
    dbNavDate: current.nav_date,
  };
}

// ─── Event classification ────────────────────────────────────────────────

/**
 * Turn the CSV's contribution rows into `ClassifiedEvent`s against the
 * live ledger. Voluntary and internal rows are emitted as
 * `skipped_voluntary` / `skipped_internal` so the UI can still enumerate
 * everything the CSV surfaced (transparent, no silent drops). Payroll
 * rows go through the 4-status classifier.
 *
 * The classifier is careful to not double-match a single ledger row
 * against multiple CSV rows. It maintains a `usedLedgerIds` set and
 * excludes those from subsequent lookups. In practice this only ever
 * matters if the CSV had a duplicate — which CAMS shouldn't ever
 * produce — but it's the right defensive shape.
 */
function classifyEvents(
  parsed: ParsedCas,
  ledger: LedgerRowSnapshot[]
): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];
  const usedLedgerIds = new Set<number>();

  // Only NPS payroll rows are candidates for ledger operations
  const payrollLedger = ledger.filter((r) => r.credit_type === "payroll");

  for (let i = 0; i < parsed.contributions.length; i++) {
    const row = parsed.contributions[i];
    const key = `csv-${i}-${row.dateIso}-${row.total.toFixed(2)}`;

    if (row.category === "voluntary") {
      events.push({
        key,
        status: "skipped_voluntary",
        csv: {
          dateIso: row.dateIso,
          amountInr: row.total,
          creditType: "payroll", // not used by voluntary rows
          particulars: row.particulars,
          category: row.category,
        },
        ledgerMatch: null,
        daysApart: null,
        amountDelta: null,
        reason:
          "Voluntary contribution — baked into total_invested_inr on nps_state, not logged as a discrete ledger event (per Jul 17 user decision).",
      });
      continue;
    }

    if (row.category === "internal") {
      events.push({
        key,
        status: "skipped_internal",
        csv: {
          dateIso: row.dateIso,
          amountInr: row.total,
          creditType: "payroll",
          particulars: row.particulars,
          category: row.category,
        },
        ledgerMatch: null,
        daysApart: null,
        amountDelta: null,
        reason:
          "Internal accounting entry (billing charge, SPC transfer, etc.) — not a user contribution.",
      });
      continue;
    }

    // payroll — run the 4-status classifier

    // 1. Exact triple match?
    const exact = payrollLedger.find(
      (l) =>
        !usedLedgerIds.has(l.id) &&
        l.credit_date === row.dateIso &&
        Math.abs(l.amount_inr - row.total) <= AMOUNT_EQ_TOLERANCE_INR
    );
    if (exact) {
      usedLedgerIds.add(exact.id);
      events.push({
        key,
        status: "exact_duplicate",
        csv: {
          dateIso: row.dateIso,
          amountInr: row.total,
          creditType: "payroll",
          particulars: row.particulars,
          category: row.category,
        },
        ledgerMatch: exact,
        daysApart: 0,
        amountDelta: row.total - exact.amount_inr,
        reason: "Already in ledger with same date and amount — will skip.",
      });
      continue;
    }

    // 2. Same date, different amount?
    const amountMismatch = payrollLedger.find(
      (l) =>
        !usedLedgerIds.has(l.id) &&
        l.credit_date === row.dateIso &&
        Math.abs(l.amount_inr - row.total) > AMOUNT_EQ_TOLERANCE_INR
    );
    if (amountMismatch) {
      usedLedgerIds.add(amountMismatch.id);
      events.push({
        key,
        status: "amount_mismatch",
        csv: {
          dateIso: row.dateIso,
          amountInr: row.total,
          creditType: "payroll",
          particulars: row.particulars,
          category: row.category,
        },
        ledgerMatch: amountMismatch,
        daysApart: 0,
        amountDelta: row.total - amountMismatch.amount_inr,
        reason: `Ledger has ₹${amountMismatch.amount_inr.toFixed(
          2
        )} on ${row.dateIso}, CAS says ₹${row.total.toFixed(
          2
        )}. Default: overwrite ledger with CAS amount.`,
      });
      continue;
    }

    // 3. Near-duplicate? (same amount ± ₹1, within ±3 days, not already used)
    const nearDup = payrollLedger
      .filter((l) => !usedLedgerIds.has(l.id))
      .map((l) => ({ l, days: daysBetween(l.credit_date, row.dateIso) }))
      .find(
        ({ l, days }) =>
          days > 0 &&
          days <= NEAR_DUP_WINDOW_DAYS &&
          Math.abs(l.amount_inr - row.total) <= AMOUNT_EQ_TOLERANCE_INR
      );
    if (nearDup) {
      usedLedgerIds.add(nearDup.l.id);
      events.push({
        key,
        status: "near_duplicate",
        csv: {
          dateIso: row.dateIso,
          amountInr: row.total,
          creditType: "payroll",
          particulars: row.particulars,
          category: row.category,
        },
        ledgerMatch: nearDup.l,
        daysApart: nearDup.days,
        amountDelta: row.total - nearDup.l.amount_inr,
        reason: `Ledger has same amount on ${nearDup.l.credit_date} (${nearDup.days} day${
          nearDup.days === 1 ? "" : "s"
        } off from CAS's ${row.dateIso}). Default: replace ledger entry with CAS date (CAS is authoritative).`,
      });
      continue;
    }

    // 4. Truly new
    events.push({
      key,
      status: "new",
      csv: {
        dateIso: row.dateIso,
        amountInr: row.total,
        creditType: "payroll",
        particulars: row.particulars,
        category: row.category,
      },
      ledgerMatch: null,
      daysApart: null,
      amountDelta: null,
      reason: "Not yet in the ledger — will be added.",
    });
  }

  return events;
}

// ─── Fatal-condition gate ────────────────────────────────────────────────

function collectFatalReasons(
  validation: Validation,
  parsed: ParsedCas
): string[] {
  const reasons: string[] = [];
  if (!validation.pranMatches) {
    reasons.push(
      `PRAN mismatch: nps_state has ${validation.pranCurrent}, CSV declares ${validation.pranFromCsv}. This CAS is for a different account.`
    );
  }
  if (!validation.variantIsPop) {
    reasons.push(
      `Scheme variant is not POP (found: ${validation.variantsFound.join(
        ", "
      )}). This dashboard is configured for POP variants — mixing streams would corrupt daily NAV refresh.`
    );
  }
  if (!validation.tierIsOne) {
    reasons.push(
      "Non-Tier-I scheme detected in CSV. This dashboard tracks Tier I only."
    );
  }
  if (!validation.sumChecksPass) {
    const drift = validation.sumComputed - validation.sumDeclared;
    reasons.push(
      `Sum sanity failed: Σ(units × NAV) = ₹${validation.sumComputed.toFixed(
        2
      )} but CSV declares ₹${validation.sumDeclared.toFixed(
        2
      )} (drift ₹${drift.toFixed(2)}, tolerance ₹${validation.sumTolerance}). CSV may be corrupted or truncated.`
    );
  }
  if (!validation.navDateNotRegressing) {
    reasons.push(
      `CSV NAV date ${validation.navDate} is older than DB nav_date ${validation.dbNavDate}. Fetch a fresher CAS before applying.`
    );
  }
  if (parsed.schemeSummary.length < 3) {
    reasons.push(
      `Only ${parsed.schemeSummary.length} scheme rows parsed (expected 3 for E+C+G). CSV may be truncated.`
    );
  }
  return reasons;
}

// ─── Public entry point ──────────────────────────────────────────────────

export function diffCas(
  parsed: ParsedCas,
  current: NpsStateSnapshot,
  ledger: LedgerRowSnapshot[]
): CasDiff {
  const validation = validate(current, parsed);
  const stateDiff = computeStateDiff(current, parsed);
  const events = classifyEvents(parsed, ledger);

  const summary = {
    new: events.filter((e) => e.status === "new").length,
    exact_duplicate: events.filter((e) => e.status === "exact_duplicate").length,
    amount_mismatch: events.filter((e) => e.status === "amount_mismatch").length,
    near_duplicate: events.filter((e) => e.status === "near_duplicate").length,
    skipped_voluntary: events.filter((e) => e.status === "skipped_voluntary").length,
    skipped_internal: events.filter((e) => e.status === "skipped_internal").length,
    voluntaryTotalInr: parsed.computed.voluntaryTotal,
    payrollTotalInr: parsed.computed.payrollTotal,
  };

  const fatalReasons = collectFatalReasons(validation, parsed);

  const navDateForDb =
    parsed.schemeSummary[0]?.navDateIso ?? parsed.subscriber.statementDateIso;

  return {
    parsed: {
      pran: parsed.subscriber.pran,
      navDate: navDateForDb,
      statementDate: parsed.subscriber.statementDateIso,
      subscriberName: parsed.subscriber.name,
      schemeChoice: parsed.subscriber.schemeChoice,
    },
    validation,
    stateDiff,
    events,
    summary,
    fatal: fatalReasons.length > 0,
    fatalReasons,
  };
}
