/**
 * POST /api/sync-nps/apply
 *
 * Accepts the same raw CSV as /preview, plus an optional `decisions`
 * object where the client can override per-row defaults (uncheck a
 * "new" row, or keep the ledger date instead of the CAS date on a
 * near_duplicate, etc.). Re-parses the CSV and re-diffs against LIVE
 * DB state, then calls the atomic apply_cas_reconciliation RPC.
 *
 * Request body — either
 *   text/plain: raw CSV (no decisions → all defaults apply)
 * or
 *   application/json: {
 *     csv: string,
 *     decisions?: {
 *       exclude?: string[],            // event.key values to NOT process
 *       nearDuplicate?: Record<        // event.key → resolution
 *         string,
 *         "replace_with_csv" | "keep_ledger" | "add_both"
 *       >,
 *       amountMismatch?: Record<       // event.key → resolution
 *         string,
 *         "overwrite" | "keep_ledger"
 *       >
 *     }
 *   }
 *
 * Response:
 *   { ok: true, applied: {
 *       inserted, deleted, updated, state_changed,
 *       nav_date, diff (for reference)
 *   }}
 * or on error:
 *   { ok: false, error, ... }
 */

import { NextResponse } from "next/server";
import { CamsParseError } from "@/lib/nps/camsParser";
import { computeCasDiff, extractCsv } from "@/lib/nps/casServer";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import type { ClassifiedEvent } from "@/lib/nps/casDiff";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type NearDupChoice = "replace_with_csv" | "keep_ledger" | "add_both";
type AmountMismatchChoice = "overwrite" | "keep_ledger";

type Decisions = {
  exclude?: string[];
  nearDuplicate?: Record<string, NearDupChoice>;
  amountMismatch?: Record<string, AmountMismatchChoice>;
};

/**
 * Split the diff's events into the three payload arrays the RPC expects,
 * respecting the client's decisions object. Defaults when the client
 * doesn't override:
 *   new              → insert
 *   exact_duplicate  → no-op
 *   amount_mismatch  → overwrite ledger with CAS amount
 *   near_duplicate   → replace_with_csv (delete old row, insert new)
 *   skipped_voluntary → no-op (baked into total_invested_inr)
 *   skipped_internal → no-op
 */
function buildRpcPayloads(
  events: ClassifiedEvent[],
  decisions: Decisions | undefined,
  statementDate: string
) {
  const excluded = new Set(decisions?.exclude ?? []);
  const nearChoices = decisions?.nearDuplicate ?? {};
  const amountChoices = decisions?.amountMismatch ?? {};

  const inserts: {
    credit_date: string;
    credit_type: "payroll";
    amount_inr: number;
    note: string;
  }[] = [];
  const deletes: number[] = [];
  const updates: { id: number; amount_inr: number; note: string }[] = [];

  const stampedNote = `CAS ${statementDate}`;

  for (const ev of events) {
    if (excluded.has(ev.key)) continue;

    switch (ev.status) {
      case "new":
        inserts.push({
          credit_date: ev.csv.dateIso,
          credit_type: "payroll",
          amount_inr: Number(ev.csv.amountInr.toFixed(2)),
          note: `${stampedNote} · payroll (backfilled from CAS)`,
        });
        break;
      case "exact_duplicate":
        break;
      case "amount_mismatch": {
        const choice = amountChoices[ev.key] ?? "overwrite";
        if (choice === "overwrite" && ev.ledgerMatch) {
          updates.push({
            id: ev.ledgerMatch.id,
            amount_inr: Number(ev.csv.amountInr.toFixed(2)),
            note: `${stampedNote} · overwritten from CAS (was ₹${ev.ledgerMatch.amount_inr.toFixed(
              2
            )})`,
          });
        }
        break;
      }
      case "near_duplicate": {
        const choice = nearChoices[ev.key] ?? "replace_with_csv";
        if (choice === "replace_with_csv" && ev.ledgerMatch) {
          deletes.push(ev.ledgerMatch.id);
          inserts.push({
            credit_date: ev.csv.dateIso,
            credit_type: "payroll",
            amount_inr: Number(ev.csv.amountInr.toFixed(2)),
            note: `${stampedNote} · replaced ledger id ${ev.ledgerMatch.id} (${ev.ledgerMatch.credit_date} → ${ev.csv.dateIso})`,
          });
        } else if (choice === "add_both") {
          inserts.push({
            credit_date: ev.csv.dateIso,
            credit_type: "payroll",
            amount_inr: Number(ev.csv.amountInr.toFixed(2)),
            note: `${stampedNote} · added alongside ledger id ${
              ev.ledgerMatch?.id ?? "?"
            } (user chose add_both)`,
          });
        }
        // keep_ledger → no-op
        break;
      }
      case "skipped_voluntary":
      case "skipped_internal":
        break;
    }
  }

  return { inserts, deletes, updates };
}

export async function POST(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  let csv: string | null = null;
  let decisions: Decisions | undefined;

  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as { csv?: unknown; decisions?: Decisions };
      if (typeof body.csv === "string") csv = body.csv;
      if (body.decisions && typeof body.decisions === "object") {
        decisions = body.decisions;
      }
    } else {
      csv = await extractCsv(req);
    }
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "Malformed body: " + (err instanceof Error ? err.message : String(err)),
      },
      { status: 400 }
    );
  }

  if (!csv || csv.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "Empty CSV body." },
      { status: 400 }
    );
  }

  try {
    // Fresh diff computed here (NOT trusting anything the client might
    // have sent from /preview). Also picks up any DB state change that
    // happened between preview and apply.
    const { parsed, diff } = await computeCasDiff(csv);

    if (diff.fatal) {
      return NextResponse.json(
        {
          ok: false,
          error: "CSV failed validation — cannot apply.",
          fatalReasons: diff.fatalReasons,
          diff,
        },
        { status: 400 }
      );
    }

    // Note stampedNote/audit purposes still reference the statement
    // date — it uniquely identifies which CAS export drove the write.
    // But the DB nav_date field gets the actual NAV date so refresh
    // comparisons work correctly (see casDiff.ts nav_date semantics).
    const { inserts, deletes, updates } = buildRpcPayloads(
      diff.events,
      decisions,
      diff.parsed.statementDate
    );

    // Pull the CAS-authoritative state values out of the diff. We use
    // diff.stateDiff.proposed (which came from parsed) rather than
    // parsed.schemeSummary directly so a single source (the diff) drives
    // both the response payload and the RPC.
    //
    // p_statement_date parameter carries the NAV DATE (not statement
    // date) despite its name — the RPC parameter was named early and
    // renaming requires DROP FUNCTION. Semantically this is the date
    // the NAVs correspond to.
    const { data: rpcData, error: rpcError } = await sbServer.rpc(
      "apply_cas_reconciliation",
      {
        p_pran: diff.parsed.pran,
        p_statement_date: diff.parsed.navDate,
        p_scheme_e_units: diff.stateDiff.scheme_e_units.proposed,
        p_scheme_c_units: diff.stateDiff.scheme_c_units.proposed,
        p_scheme_g_units: diff.stateDiff.scheme_g_units.proposed,
        p_scheme_e_nav: diff.stateDiff.scheme_e_nav.proposed,
        p_scheme_c_nav: diff.stateDiff.scheme_c_nav.proposed,
        p_scheme_g_nav: diff.stateDiff.scheme_g_nav.proposed,
        p_total_invested: diff.stateDiff.total_invested_inr.proposed,
        p_ledger_inserts: inserts,
        p_ledger_deletes: deletes,
        p_ledger_updates: updates,
      }
    );
    if (rpcError) {
      // Bubble up hint if the RPC RAISEd with USING HINT
      const hint = (rpcError as { hint?: string }).hint;
      return NextResponse.json(
        {
          ok: false,
          error: rpcError.message,
          hint,
        },
        { status: 500 }
      );
    }

    // recomputeNwDaily so today's nw_daily row reflects the new
    // nps_value immediately (instead of waiting for the 2 AM cron).
    // Not passing 1D overrides — the /refresh-nps-nav path handles
    // that; a CAS reconciliation is a state anchor, not a NAV cycle.
    try {
      await recomputeNwDaily();
    } catch (recErr) {
      const message = recErr instanceof Error ? recErr.message : String(recErr);
      return NextResponse.json({
        ok: true,
        partial: true,
        message: `Applied CAS reconciliation but nw_daily recompute failed: ${message}. The next cron run will fix the Overview headline.`,
        applied: rpcData,
        diff,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `Applied CAS as of ${diff.parsed.statementDate}. Inserted ${
        (rpcData as { inserted?: number })?.inserted ?? 0
      } payroll credits, deleted ${
        (rpcData as { deleted?: number })?.deleted ?? 0
      }, updated ${(rpcData as { updated?: number })?.updated ?? 0}.`,
      applied: rpcData,
      diff,
      parsedSummary: {
        payrollTotal: parsed.computed.payrollTotal,
        voluntaryTotal: parsed.computed.voluntaryTotal,
        contributionsCount: parsed.contributions.length,
      },
    });
  } catch (err) {
    if (err instanceof CamsParseError) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          section: err.section,
          hint: err.hint,
        },
        { status: 400 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-nps/apply] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
