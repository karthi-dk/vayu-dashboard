/**
 * Server-only helpers shared by /api/sync-nps/preview and /api/sync-nps/apply.
 *
 * Both routes need to:
 *   1. Read the raw CSV out of the request body (tolerating both
 *      Content-Type: text/plain and application/json variants).
 *   2. Parse it (delegates to camsParser).
 *   3. Snapshot the DB state (nps_state row + NPS payroll ledger rows).
 *   4. Run the diff.
 *
 * The apply route additionally executes the RPC and calls recomputeNwDaily.
 */

import { sbServer } from "@/lib/supabase";
import { parseCamsCsv, type ParsedCas } from "./camsParser";
import {
  diffCas,
  type CasDiff,
  type LedgerRowSnapshot,
  type NpsStateSnapshot,
} from "./casDiff";

/**
 * Extract the CSV string from a NextRequest body. We accept:
 *   • text/plain — body is the raw CSV
 *   • application/json — body is {"csv": "..."} (fallback path some
 *     clients prefer to avoid preflight surprises)
 *
 * Return null on any parse/type error; the route turns null into a 400.
 */
export async function extractCsv(req: Request): Promise<string | null> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = await req.json();
      if (typeof body === "string") return body;
      const c = (body as { csv?: unknown })?.csv;
      return typeof c === "string" ? c : null;
    }
    const text = await req.text();
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the live nps_state row (id=1) as a snapshot the diff engine can
 * consume. `pran` may be null on installations that haven't done their
 * first CAS paste yet — the diff engine treats null as "seed on first
 * paste" rather than "mismatch".
 */
async function fetchNpsSnapshot(): Promise<NpsStateSnapshot | null> {
  const { data, error } = await sbServer
    .from("nps_state")
    .select(
      "pran, scheme_e_units, scheme_c_units, scheme_g_units, scheme_e_nav, scheme_c_nav, scheme_g_nav, total_invested_inr, nav_date"
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Cast: Supabase types NUMERIC columns as string by default; Number()
  // is safe because we validated shape at the query.
  return {
    pran: (data as { pran?: string | null }).pran ?? null,
    scheme_e_units: Number(data.scheme_e_units ?? 0),
    scheme_c_units: Number(data.scheme_c_units ?? 0),
    scheme_g_units: Number(data.scheme_g_units ?? 0),
    scheme_e_nav: Number(data.scheme_e_nav ?? 0),
    scheme_c_nav: Number(data.scheme_c_nav ?? 0),
    scheme_g_nav: Number(data.scheme_g_nav ?? 0),
    total_invested_inr: Number(data.total_invested_inr ?? 0),
    nav_date: (data.nav_date as string | null) ?? null,
  };
}

/**
 * Fetch NPS payroll ledger rows. We deliberately don't filter by date
 * window — the classifier's near-duplicate check needs to compare
 * against any recent-ish row, and pulling 100 rows on a personal-scale
 * account is negligible.
 *
 * Falls back to an empty array if the retirement_credits table doesn't
 * exist yet (fresh install with the ledger migration not applied). The
 * diff engine handles that gracefully.
 */
async function fetchNpsLedger(): Promise<LedgerRowSnapshot[]> {
  const { data, error } = await sbServer
    .from("retirement_credits")
    .select("id, credit_date, credit_type, amount_inr, note")
    .eq("source", "NPS")
    .order("credit_date", { ascending: false });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") {
      // Table not yet created — treat as "no ledger events exist"
      return [];
    }
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.id as number,
    credit_date: r.credit_date as string,
    credit_type: (r.credit_type as "payroll" | "interest" | "self"),
    amount_inr: Number(r.amount_inr ?? 0),
    note: (r.note as string | null) ?? null,
  }));
}

/**
 * End-to-end: parse the CSV, snapshot DB state, produce a diff.
 * Both routes call this to guarantee they see the exact same input.
 */
export async function computeCasDiff(csv: string): Promise<{
  parsed: ParsedCas;
  snapshot: NpsStateSnapshot;
  ledger: LedgerRowSnapshot[];
  diff: CasDiff;
}> {
  const parsed = parseCamsCsv(csv);
  const snapshot = await fetchNpsSnapshot();
  if (!snapshot) {
    throw new Error(
      "nps_state row (id=1) not found. Seed nps_state via Settings before pasting a CAS."
    );
  }
  const ledger = await fetchNpsLedger();
  const diff = diffCas(parsed, snapshot, ledger);
  return { parsed, snapshot, ledger, diff };
}
