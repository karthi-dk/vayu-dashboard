"use server";

import { revalidatePath } from "next/cache";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import { istDate } from "@/lib/istDate";
import {
  AUTO_TX_SOURCE,
  deriveAutoTxRows,
  type AutoTxNavLookup,
  type NpsSchemeCode,
} from "@/lib/npscra/deriveAutoTx";

type ActionResult = { ok: true } | { ok: false; error: string };

async function ok(): Promise<ActionResult> {
  // Every mutation here changes something that feeds into total_nw. Skipping
  // this recompute means the Overview headline stays stale until the 2 AM
  // cron runs, so we always call it after a successful write. Failure of the
  // recompute is surfaced but the underlying write is already committed.
  try {
    await recomputeNwDaily();
  } catch (e) {
    return {
      ok: false,
      error: `Value saved, but nw_daily recompute failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
function err(e: unknown): ActionResult {
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, error: message };
}

export async function saveEpf(input: {
  balance_inr: number;
  monthly_contribution_inr: number;
}): Promise<ActionResult> {
  try {
    const { error } = await sbServer
      .from("epf_state")
      .update({
        balance_inr: input.balance_inr,
        monthly_contribution_inr: input.monthly_contribution_inr,
        last_verified_date: istDate(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw error;
    return await ok();
  } catch (e) {
    return err(e);
  }
}

// ─── Retirement credits ledger ───────────────────────────────────────────

type CreditSourceInput = "EPF" | "NPS";
// Note: `self` was retired on Jul 17, 2026 — user does not make voluntary
// top-ups. DB CHECK still allows it but no code path can produce it.
type CreditTypeInput = "payroll" | "interest";

/**
 * Log a single credit event to the `retirement_credits` ledger.
 *
 * Every insert atomically updates the parent state row via the
 * `log_retirement_credit` RPC (see migration 2026-07-16-retirement-
 * credits-ledger.sql). The RPC handles:
 *   EPF → adds amount_inr to epf_state.balance_inr, stamps
 *         last_interest_credit_* on interest events
 *   NPS → splits amount by alloc_e/c/g at current NAV, adds units to
 *         nps_state.scheme_*_units, bumps total_invested_inr
 *
 * Uniqueness enforced by the DB: (source, credit_date, credit_type) is
 * unique. Duplicate inserts raise 23505 which we translate to a friendly
 * error message.
 */
export async function logRetirementCredit(input: {
  source: CreditSourceInput;
  credit_date: string;
  credit_type: CreditTypeInput;
  amount_inr: number;
  note?: string | null;
}): Promise<ActionResult> {
  try {
    if (input.source !== "EPF" && input.source !== "NPS") {
      return { ok: false, error: "source must be EPF or NPS" };
    }
    if (
      input.credit_type !== "payroll" &&
      input.credit_type !== "interest"
    ) {
      return { ok: false, error: "credit_type must be payroll or interest" };
    }
    if (input.credit_type === "interest" && input.source !== "EPF") {
      return { ok: false, error: "Interest credits only apply to EPF" };
    }
    if (!Number.isFinite(input.amount_inr) || input.amount_inr <= 0) {
      return { ok: false, error: "Amount must be a positive number" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.credit_date)) {
      return { ok: false, error: "Credit date must be YYYY-MM-DD" };
    }

    const { error } = await sbServer.rpc("log_retirement_credit", {
      p_source: input.source,
      p_credit_date: input.credit_date,
      p_credit_type: input.credit_type,
      p_amount_inr: input.amount_inr,
      p_note: input.note ?? null,
    });
    if (error) {
      // Postgres unique-violation → friendly message
      if ((error as { code?: string }).code === "23505") {
        return {
          ok: false,
          error: `Already logged: ${input.source} ${input.credit_type} on ${input.credit_date}`,
        };
      }
      throw error;
    }

    // Auto-derive 3 nps_transactions rows (E/C/G) so the NPS Growth
    // breakdown chart moves the moment this credit lands, without
    // waiting for the user's next CRA SOT paste. See
    // deriveAutoTxRows for the estimation caveats. A failure here is
    // non-fatal: the retirement_credits row is already committed and
    // the NW Trend chart's SummaryStrip picks it up. Only the NPS
    // per-scheme chart stays stale until the next paste ingest.
    if (input.source === "NPS" && input.credit_type === "payroll") {
      try {
        await autoDeriveNpsTx({
          credit_date: input.credit_date,
          credit_amount: input.amount_inr,
        });
      } catch (autoErr) {
        console.warn(
          "[actions] auto-derive nps_transactions failed for credit " +
            `${input.credit_date}: ${
              autoErr instanceof Error ? autoErr.message : String(autoErr)
            }. Retirement credit was still committed — NPS chart will ` +
            "sync on next CRA paste."
        );
      }
    }

    return await ok();
  } catch (e) {
    return err(e);
  }
}

/**
 * Best-effort mirror: on an NPS payroll credit, insert three
 * source='auto_credits' rows into nps_transactions (one per scheme).
 *
 * Not part of the log_retirement_credit RPC because that RPC lives in
 * the DB (Postgres function) and adding table writes there is a
 * deploy of its own. Doing it here in the server action gives us the
 * same one-round-trip commit story for the user (RPC → mirror →
 * recompute) at the cost of a rare race window if the mirror fails
 * after the RPC succeeds (recovered by paste ingest, see wipe logic
 * in /api/sync-nps-cra).
 *
 * Assumptions:
 *   • Reads current alloc from nps_state (row id=1, singleton).
 *   • Reads NAV per scheme from nps_nav_history for the exact credit
 *     date; falls back to nearest earlier date if the credit lands on
 *     a non-trading day.
 *   • Uses contribution_side='employer' by default — matches the
 *     user's setup (all NPS deposits routed via employer payroll).
 */
async function autoDeriveNpsTx(input: {
  credit_date: string;
  credit_amount: number;
}): Promise<void> {
  const stateRes = await sbServer
    .from("nps_state")
    .select("alloc_e_pct,alloc_c_pct,alloc_g_pct")
    .eq("id", 1)
    .maybeSingle();
  if (stateRes.error) throw stateRes.error;
  if (!stateRes.data) {
    console.warn("[actions] nps_state not seeded — skipping auto-derive");
    return;
  }

  // Pull all NAVs on-or-before credit_date. Cheap (small table) and
  // avoids 3 sequential round-trips (one per scheme).
  const navRes = await sbServer
    .from("nps_nav_history")
    .select("scheme,nav_date,nav")
    .in("scheme", ["E", "C", "G"])
    .lte("nav_date", input.credit_date)
    .order("nav_date", { ascending: false })
    .limit(30); // 30 rows across 3 schemes covers ~10 trading days back
  if (navRes.error) throw navRes.error;

  const latestByScheme = new Map<NpsSchemeCode, number>();
  for (const r of navRes.data ?? []) {
    const scheme = r.scheme as NpsSchemeCode;
    if (!latestByScheme.has(scheme)) latestByScheme.set(scheme, Number(r.nav));
  }
  const navLookup: AutoTxNavLookup = (scheme) => latestByScheme.get(scheme) ?? null;

  const rows = deriveAutoTxRows({
    credit_date: input.credit_date,
    credit_type: "payroll",
    credit_amount: input.credit_amount,
    alloc: stateRes.data,
    navLookup,
  });
  if (!rows) {
    // Missing NAV or bad alloc — skip silently. The chart will sync
    // on next CRA paste. Log so we notice systematic gaps.
    console.warn(
      `[actions] auto-derive skipped for ${input.credit_date}: missing NAV ` +
        "or alloc doesn't sum to 100%"
    );
    return;
  }

  const upsertRes = await sbServer
    .from("nps_transactions")
    .upsert(rows, {
      onConflict: "source,tx_hash",
      ignoreDuplicates: true,
    });
  if (upsertRes.error) throw upsertRes.error;
}

/**
 * Delete a credit event AND reverse its effect on parent state. Both
 * happen in one transaction via the `delete_retirement_credit` RPC.
 * Used by the /credits page's row-level delete button when the user
 * needs to correct a mistaken entry.
 */
export async function deleteRetirementCredit(input: {
  id: number;
}): Promise<ActionResult> {
  try {
    if (!Number.isFinite(input.id) || input.id <= 0) {
      return { ok: false, error: "Invalid id" };
    }

    // Look up the credit's (source, credit_date, credit_type) BEFORE
    // deleting — we need those to identify and reap any auto-derived
    // nps_transactions rows we wrote in logRetirementCredit. Missing
    // credit row (already deleted) is fine; the RPC will report a
    // no-op and we skip the mirror cleanup.
    const lookupRes = await sbServer
      .from("retirement_credits")
      .select("source,credit_date,credit_type")
      .eq("id", input.id)
      .maybeSingle();
    if (lookupRes.error) throw lookupRes.error;

    const { error } = await sbServer.rpc("delete_retirement_credit", {
      p_id: input.id,
    });
    if (error) throw error;

    if (
      lookupRes.data &&
      lookupRes.data.source === "NPS" &&
      lookupRes.data.credit_type === "payroll"
    ) {
      // Reap the three auto-derived rows (one per scheme) for this
      // credit date. Best-effort — a failure here leaves 3 orphaned
      // rows on the NPS chart until the next CRA paste wipes them.
      try {
        const delRes = await sbServer
          .from("nps_transactions")
          .delete()
          .eq("source", AUTO_TX_SOURCE)
          .eq("tx_date", lookupRes.data.credit_date);
        if (delRes.error) throw delRes.error;
      } catch (mirrorErr) {
        console.warn(
          `[actions] auto-derive cleanup failed for credit ${input.id}: ${
            mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)
          }. Credit deleted; NPS chart will self-correct on next paste.`
        );
      }
    }

    return await ok();
  } catch (e) {
    return err(e);
  }
}

export async function saveNpsUnits(input: {
  scheme_e_units: number;
  scheme_c_units: number;
  scheme_g_units: number;
}): Promise<ActionResult> {
  try {
    const { error } = await sbServer
      .from("nps_state")
      .update({
        scheme_e_units: input.scheme_e_units,
        scheme_c_units: input.scheme_c_units,
        scheme_g_units: input.scheme_g_units,
        last_units_update: istDate(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw error;
    return await ok();
  } catch (e) {
    return err(e);
  }
}

export async function saveNpsContribution(input: {
  monthly_contribution_inr: number;
}): Promise<ActionResult> {
  try {
    const { error } = await sbServer
      .from("nps_state")
      .update({
        monthly_contribution_inr: input.monthly_contribution_inr,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw error;
    // Contribution amount doesn't feed into today's NW (only future ones),
    // but we still return ok() so the caller gets consistent flow. Skipping
    // the recompute here would be a valid micro-optimization but not worth
    // the branching for a personal-scale app.
    return await ok();
  } catch (e) {
    return err(e);
  }
}

/**
 * Log a single MF transaction that happened OUTSIDE Groww (direct
 * AMC SIP, ICICI/HDFC/etc. app, offline paperwork). Writes to the
 * same `mf_transactions` table as CAS ingestion so the row shows up
 * on /credits and enters the ledger-derived deposits curve on the
 * Overview MF chart. See lib/mf/logMfTx.ts for the hash formula and
 * CAS-alignment rationale.
 *
 * Idempotent by (fund_code, tx_date, tx_type, amount, units) — the
 * deterministic `tx_hash` collapses same-trade re-submits to one row.
 * User can re-submit the same purchase a hundred times without polluting
 * the ledger.
 *
 * Amount contract:
 *   • Input `amount_inr` is the GROSS amount the user told the AMC
 *     (e.g., 10000 for a ₹10K purchase).
 *   • SEBI stamp duty (0.005%) is deducted server-side and the NET
 *     amount is what lands in the DB — matching how CAS records the
 *     "amount NAV was actually applied to" (e.g., 9999.50 for ₹10K).
 *   • This mirrors Groww's `order.amount` (paise) semantics and
 *     keeps the reconstruction NAV math internally consistent.
 */
export async function logMfTransaction(input: {
  fund_code: string;
  tx_date: string; // YYYY-MM-DD — the order/instalment date, recorded as-is in the ledger
  tx_type: "purchase" | "redemption";
  amount_inr: number; // gross, before stamp duty
  // NAV date, if it differs from tx_date — e.g. an order placed after the
  // 3 PM cutoff gets T+1's NAV, not T's. Null/omitted means "same as
  // tx_date" (the common case, and the only option before this field
  // existed). Distinct from tx_date because tx_date is what actually
  // happened (when you placed the order / your instalment date) while
  // this is purely a NAV-lookup hint — the two can legitimately differ by
  // a day without the transaction itself having happened on a different
  // date.
  nav_date?: string | null;
  nav_override?: number | null; // if user knows the exact NAV; skips mfapi lookup
  description_note?: string | null;
  // Source system's own unique identifier — INDmoney's TxnID today.
  // When set, this row is idempotent by (source, source_ref) via the
  // partial unique index in migration 2026-07-24-mf-transactions-
  // source-ref.sql, checked BEFORE the expensive NAV lookup so a
  // repeat paste short-circuits immediately. Independent of tx_hash,
  // which still guards cross-source dedup for rows that lack an
  // upstream ID (hand-typed manual entries, CAS re-pastes).
  source_ref?: string | null;
  // Purchase platform — WHERE the order was actually placed
  // (INDmoney / ICICI Prudential / etc.), distinct from `source` which
  // captures the ingest mechanism. Optional so hand-typed entries that
  // pre-date the platform dropdown still work; new entries all pass a
  // value. See lib/mf/platform.ts for the vocabulary and migration
  // 2026-07-24-mf-platform.sql for the column design.
  platform?: string | null;
  // Provenance label for the NAV used — stamped into `raw.nav_source`
  // for the audit trail. Only meaningful when `nav_override` is also
  // set (otherwise the NAV came from mfapi.in and the label auto-
  // resolves to "mfapi.in"). Callers who pass an override without a
  // label default to "user_override" — the pre-existing behavior.
  //   • "indmoney"      — parsed from INDmoney JSON (Subtitle2 field)
  //   • "user_override" — hand-typed into the manual form
  nav_source_label?: string | null;
  // When the user actually clicked Buy — distinct from tx_date, which
  // stores the NAV date (day whose NAV was applied). Populated from
  // INDmoney bulk-list Subtitle1, or from an explicit user input.
  // Null means "same as tx_date" (rendered as a single date in the
  // ledger UI). See migration 2026-07-24-mf-transactions-placed-date
  // .sql for the schema-level semantics.
  placed_date?: string | null;
}): Promise<
  | {
      ok: true;
      tx_hash: string;
      amount: number;
      nav: number;
      units: number;
      nav_date: string;
      duplicate: boolean;
    }
  | { ok: false; error: string }
> {
  try {
    // Dynamic imports keep the client bundle lean — this action is
    // only ever called from the /sync page's card, so pulling the
    // helper module lazily is fine.
    const {
      MANUAL_TX_SOURCE,
      computeMfTxHash,
      fetchNavForDate,
      schemeCodeForFund,
      stampDutyForPurchase,
    } = await import("@/lib/mf/logMfTx");

    // ── 1. Validate fund ────────────────────────────────────────
    const schemeCode = schemeCodeForFund(input.fund_code);
    if (!schemeCode) {
      return { ok: false, error: `Unknown fund_code: ${input.fund_code}` };
    }

    // ── 2. Validate amount + date ───────────────────────────────
    if (
      !Number.isFinite(input.amount_inr) ||
      input.amount_inr <= 0
    ) {
      return { ok: false, error: "Amount must be a positive number" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tx_date)) {
      return {
        ok: false,
        error: "Date must be in YYYY-MM-DD format",
      };
    }
    if (input.nav_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.nav_date)) {
      return {
        ok: false,
        error: "NAV date must be in YYYY-MM-DD format",
      };
    }
    if (
      input.placed_date != null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(input.placed_date)
    ) {
      return {
        ok: false,
        error: "Placed date must be in YYYY-MM-DD format",
      };
    }

    // ── 2b. Strong-key dedup (source_ref) ───────────────────────
    // If the caller supplied a source-side unique ID, check for an
    // existing row with the same (source, source_ref) FIRST — before
    // the NAV lookup or any hash computation. Cuts an mfapi round-
    // trip on every bulk re-paste of an already-logged INDmoney
    // order. See migration 2026-07-24-mf-transactions-source-ref.sql
    // for why this is a stronger idempotency guarantee than tx_hash
    // for source-tagged rows (immune to display-rounding artefacts
    // on the amount).
    if (input.source_ref != null && input.source_ref.trim() !== "") {
      const existingByRef = await sbServer
        .from("mf_transactions")
        .select("tx_hash,amount,nav,units,tx_date")
        .eq("source", MANUAL_TX_SOURCE)
        .eq("source_ref", input.source_ref.trim())
        .maybeSingle();
      if (!existingByRef.error && existingByRef.data) {
        const row = existingByRef.data as {
          tx_hash: string;
          amount: number | string;
          nav: number | string;
          units: number | string;
          tx_date: string;
        };
        return {
          ok: true,
          tx_hash: row.tx_hash,
          amount: Math.abs(Number(row.amount)),
          nav: Number(row.nav),
          units: Math.abs(Number(row.units)),
          nav_date: row.tx_date,
          duplicate: true,
        };
      }
    }

    // NAV lookup target — defaults to tx_date (the pre-existing behavior,
    // still the overwhelming common case: same-day cutoff, no T+1
    // spillover). Only diverges when the caller explicitly supplies a
    // distinct nav_date, e.g. an order placed after the 3 PM cutoff.
    const navLookupTarget = input.nav_date ?? input.tx_date;

    // ── 3. Determine NAV ────────────────────────────────────────
    let nav: number;
    let navDate: string;
    let schemeName: string;
    if (
      input.nav_override != null &&
      Number.isFinite(input.nav_override) &&
      input.nav_override > 0
    ) {
      // User-provided NAV path — trust it. Record navLookupTarget (not
      // always tx_date anymore) as the date this NAV applied to — a
      // manual override is claiming "this is the NAV that was actually
      // applied on [navLookupTarget]", which may be a day after tx_date
      // if the caller flagged a T+1 cutoff via nav_date.
      nav = input.nav_override;
      navDate = navLookupTarget;
      schemeName = "";
    } else {
      const lookup = await fetchNavForDate(schemeCode, navLookupTarget);
      if (!lookup.ok) {
        return {
          ok: false,
          error: `Could not fetch NAV for ${input.fund_code} on ${navLookupTarget}: ${lookup.error}. Try providing NAV explicitly or check the date.`,
        };
      }
      nav = lookup.nav;
      navDate = lookup.nav_date;
      schemeName = lookup.scheme_name;
    }

    // ── 4. Apply stamp duty (purchase only) ─────────────────────
    const stampDuty = stampDutyForPurchase(input.amount_inr, input.tx_type);
    const netAmount = Number((input.amount_inr - stampDuty).toFixed(2));

    // ── 5. Compute units — same 4-dp rounding CAS uses ──────────
    // Redemptions are recorded with negative amount + negative units
    // so per-fund position tracking stays additive; user-facing form
    // asks for a positive amount and we flip the sign here.
    const signedAmount = input.tx_type === "redemption" ? -netAmount : netAmount;
    const rawUnits = signedAmount / nav;
    const units = Number(rawUnits.toFixed(4));

    // ── 6. Look up folio from the current fund_holdings snapshot ─
    // For AMC-direct SIPs the folio is stable and matches the folio
    // already recorded against the fund. Falling back to null if
    // we don't have it — the row still ingests, folio just stays
    // unknown until the user manually sets it or CAS fills it in.
    const folioRes = await sbServer
      .from("fund_holdings")
      .select("folio_number")
      .eq("fund_code", input.fund_code)
      .maybeSingle();
    const folio =
      folioRes.error ? null : (folioRes.data?.folio_number ?? null);

    // ── 7. Prefer the actual CAS scheme_name over the mfapi one so
    //     the row visually matches other CAS rows in the ledger.
    //     Falls back to mfapi's name, then to a "$fund_code" stub.
    let finalSchemeName = schemeName;
    const nameRes = await sbServer
      .from("mf_transactions")
      .select("scheme_name_raw")
      .eq("fund_code", input.fund_code)
      .not("scheme_name_raw", "is", null)
      .order("tx_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!nameRes.error && nameRes.data?.scheme_name_raw) {
      finalSchemeName = nameRes.data.scheme_name_raw as string;
    }
    if (!finalSchemeName) finalSchemeName = input.fund_code;

    // ── 8. Compute deterministic tx_hash + upsert ───────────────
    // Hash is amount-only (no units) so a future CAS re-paste
    // of the same trade collapses onto this row via upsert even
    // if CAS's allotted units differ by ~1 mu from computed
    // amount/nav.
    //
    // source_ref is passed through when present so two DISTINCT
    // upstream orders with otherwise-identical fund/date/type/
    // amount get different hashes and coexist as separate rows.
    // CAS rows have no source_ref and use the short-form hash,
    // preserving cross-source dedup. See computeMfTxHash's doc
    // comment in logMfTx.ts for the full rationale.
    const tx_hash = computeMfTxHash({
      fund_code: input.fund_code,
      tx_date: input.tx_date,
      tx_type: input.tx_type,
      amount: signedAmount,
      source_ref: input.source_ref,
    });

    const description =
      input.description_note?.trim() ||
      (input.tx_type === "purchase"
        ? "Manual entry — direct-AMC purchase (non-Groww)"
        : "Manual entry — direct-AMC redemption (non-Groww)");

    // Check whether the row already exists so we can tell the user
    // "recorded" vs "already logged, nothing changed".
    const existing = await sbServer
      .from("mf_transactions")
      .select("tx_hash")
      .eq("tx_hash", tx_hash)
      .maybeSingle();
    const duplicate = !existing.error && existing.data != null;

    // Build the row imperatively so the source_ref column is OMITTED
    // entirely when the caller didn't pass one — protects hand-typed
    // manual-form writes against breaking in a pre-migration Supabase
    // instance where the column doesn't exist yet. Callers who DO
    // pass a source_ref implicitly require the migration and will
    // fail loudly if it hasn't been applied (which is desired — the
    // whole point of passing it is the strong-key dedup guarantee).
    const trimmedRef = input.source_ref?.trim();
    const rowToUpsert: Record<string, unknown> = {
      source: MANUAL_TX_SOURCE,
      tx_hash,
      tx_date: input.tx_date,
      fund_code: input.fund_code,
      folio_number: folio,
      tx_type: input.tx_type,
      amount: signedAmount,
      nav,
      units,
      scheme_name_raw: finalSchemeName,
      description_raw: description,
      raw: {
        manual: true,
        gross_amount_inr: input.amount_inr,
        stamp_duty_inr: stampDuty,
        nav_source:
          input.nav_override != null
            ? (input.nav_source_label ?? "user_override")
            : "mfapi.in",
        // nav_date_requested: what the caller asked for (tx_date if the
        // "same date" checkbox was on, else the explicit T+1-style
        // override). nav_date_actual: what fetchNavForDate() actually
        // resolved to after walking back over weekends/holidays — the
        // two differ when navLookupTarget itself fell on a non-trading
        // day. Both are worth keeping distinct for provenance if this
        // row is ever audited against a CAS re-paste.
        nav_date_requested: navLookupTarget,
        nav_date_actual: navDate,
        // Redundant with the top-level column when set, but the
        // top-level column may be omitted (pre-migration) — this
        // preserves provenance in the audit JSONB regardless.
        ...(trimmedRef != null && trimmedRef !== "" ? { source_ref: trimmedRef } : {}),
        // Same idea for placed_date: preserve in JSONB even if the
        // top-level column isn't yet on the target schema.
        ...(input.placed_date != null && input.placed_date !== ""
          ? { placed_date: input.placed_date }
          : {}),
      },
    };
    if (trimmedRef != null && trimmedRef !== "") {
      rowToUpsert.source_ref = trimmedRef;
    }
    // Same "omit if unset" pattern as source_ref — protects pre-
    // migration workflows where the platform column doesn't exist yet.
    const trimmedPlatform = input.platform?.trim();
    if (trimmedPlatform != null && trimmedPlatform !== "") {
      rowToUpsert.platform = trimmedPlatform;
    }
    // Only include placed_date when it's meaningfully different from
    // tx_date (the NAV date). Storing tx_date === placed_date would
    // clutter every legitimate T+0 order with redundant data; the UI
    // treats null placed_date as "same as tx_date" and folds to a
    // single line. Callers who genuinely want to record "yes, I placed
    // it on the same day as the NAV" don't gain anything by writing
    // it to the DB — the ledger renders identically either way.
    if (
      input.placed_date != null &&
      input.placed_date !== "" &&
      input.placed_date !== input.tx_date
    ) {
      rowToUpsert.placed_date = input.placed_date;
    }
    // Conflict target must match the unique constraint on the table,
    // which is (source, tx_hash) not just tx_hash — see
    // migrations/2026-07-18-mf-transactions.sql line 86:
    //   constraint mf_transactions_source_hash_uk unique (source, tx_hash)
    // Passing just "tx_hash" yields the Postgres 42P10 error "there is
    // no unique or exclusion constraint matching the ON CONFLICT
    // specification". Compound conflict target matches nps_transactions
    // convention on line 230 above.
    const upsert = await sbServer
      .from("mf_transactions")
      .upsert(rowToUpsert, { onConflict: "source,tx_hash" });
    if (upsert.error) {
      return { ok: false, error: `Upsert failed: ${upsert.error.message}` };
    }

    // ── 9. Bump fund_holdings + refresh nw_daily on NEW inserts ───
    //
    // Historically this action skipped both writes on the (correct at
    // the time) assumption that fund_holdings was ALWAYS refreshed
    // shortly after via a Groww/Dhan JSON paste, which would overwrite
    // units + invested_inr from the platform's authoritative snapshot
    // and pick up any newly-logged trades. That assumption broke once
    // the user moved off Groww for new orders (INDmoney bulk paste +
    // MFCentral direct-AMC purchases → no subsequent Groww JSON to
    // rebase from) — leaving the headline MF card's "invested"
    // and gain % stuck at pre-log values indefinitely.
    //
    // Fix: on each genuinely NEW row (`!duplicate` guards against
    // double-counting when the same INDmoney JSON is pasted twice —
    // the second paste is a no-op UPDATE on the mf_transactions row,
    // so its units/amount must NOT be re-added to fund_holdings),
    // apply the delta to fund_holdings and recompute today's nw_daily.
    //
    // Delta semantics
    // ---------------
    // • units       += signedUnits    (positive for purchase, negative
    //                                  for redemption — sign is already
    //                                  set upstream at line 549)
    // • invested_inr += signedAmount  (same sign convention)
    // • current_value_inr = new_units × fund_holdings.nav
    //
    // Redemption cost basis is approximated linearly (invested_inr -=
    // net proceeds) rather than proportionally (invested_inr *= new_units
    // / old_units). Not strictly Groww's convention, but the user's
    // pattern is overwhelmingly purchases; getting this exactly right
    // would need a lot-tracking layer and doesn't move the needle for
    // their actual portfolio math. When a real redemption happens and
    // it matters, a CAS paste can rebase the cost basis authoritatively.
    //
    // 1D chip semantics preserved
    // ---------------------------
    // recomputeNwDaily() writes today's row but only touches the 1D
    // fields when explicit overrides are passed — we pass none here.
    // So the mf_1d_change_inr/pct from the last NAV rotation stays
    // untouched. That's correct: 1D is "market P&L on units held" —
    // buying new units at today's NAV contributes ₹0 to today's 1D
    // (they had no NAV move relative to purchase price). Tomorrow's
    // refresh-mf-nav will start including the newly-added units in
    // its market-move calculation, exactly as it should.
    // Studio test-mode gate: platform='test' rows land in
    // mf_transactions for inspection (so the tester can verify the
    // exact payload that would land in production) but MUST NOT
    // bump fund_holdings or nw_daily — otherwise every rehearsal
    // run would inflate the MF card and pollute the growth chart.
    // Isolating it here (rather than in queries.ts) means EVERY
    // downstream calculation that reads fund_holdings/nw_daily
    // (headline card, XIRR, allocation, sparkline, 1D chip) stays
    // clean automatically, no per-query filter needed.
    const isTestRow = input.platform === "test";
    if (!duplicate && !isTestRow) {
      try {
        const holdingRes = await sbServer
          .from("fund_holdings")
          .select("units, invested_inr, nav")
          .eq("fund_code", input.fund_code)
          .maybeSingle();
        if (holdingRes.error) {
          // Non-fatal: the ledger row is already committed; we just
          // won't propagate to fund_holdings. Log so the audit trail
          // catches this instead of silently drifting.
          console.warn(
            `[logMfTransaction] fund_holdings read failed for ${input.fund_code}: ${holdingRes.error.message}`
          );
        } else if (holdingRes.data == null) {
          // First-ever manual log of a fund not yet in fund_holdings.
          // We deliberately don't INSERT here — a proper new-fund row
          // needs isin/scheme_code/cap_type/nav_source/etc. that this
          // action can't materialize. User workflow: paste Groww/CAS
          // once to seed the row, then future manual logs update it.
          console.warn(
            `[logMfTransaction] fund_holdings has no row for ${input.fund_code}; skipping headline bump. Seed fund_holdings via a CAS/Groww paste and re-log if you want the MF headline to reflect this trade.`
          );
        } else {
          const oldUnits = Number(holdingRes.data.units ?? 0);
          const oldInvested = Number(holdingRes.data.invested_inr ?? 0);
          const currentNav = Number(holdingRes.data.nav ?? 0);
          const newUnits = Number((oldUnits + units).toFixed(4));
          const newInvested = Number((oldInvested + signedAmount).toFixed(2));
          const newValue =
            currentNav > 0
              ? Number((newUnits * currentNav).toFixed(2))
              : null;
          const patch: Record<string, unknown> = {
            units: newUnits,
            invested_inr: newInvested,
          };
          if (newValue != null) patch.current_value_inr = newValue;
          const holdingUpd = await sbServer
            .from("fund_holdings")
            .update(patch)
            .eq("fund_code", input.fund_code);
          if (holdingUpd.error) {
            console.warn(
              `[logMfTransaction] fund_holdings update failed for ${input.fund_code}: ${holdingUpd.error.message}`
            );
          } else {
            // Only recompute nw_daily if the fund_holdings write
            // actually landed — otherwise we'd overwrite today's row
            // with pre-log totals AND lose the 1D chip in the process
            // (recomputeNwDaily's "preserve if undefined" semantics
            // save us on the 1D side, but the totals would still be
            // wrong until the next explicit refresh).
            try {
              await recomputeNwDaily();
            } catch (nwErr) {
              console.warn(
                `[logMfTransaction] recomputeNwDaily failed: ${
                  nwErr instanceof Error ? nwErr.message : String(nwErr)
                }`
              );
            }
          }
        }
      } catch (err) {
        // Belt-and-braces catch: any unexpected failure in the headline-
        // propagation block should never block the primary mf_transactions
        // write from succeeding. The ledger row IS the source of truth;
        // fund_holdings/nw_daily are downstream views that can always be
        // reconciled later via a Groww/CAS paste or the reconcile script.
        console.warn(
          `[logMfTransaction] headline propagation errored: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    revalidatePath("/", "layout");
    return {
      ok: true,
      tx_hash,
      amount: Math.abs(signedAmount),
      nav,
      units: Math.abs(units),
      nav_date: navDate,
      duplicate,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Pre-flight duplicate check for the INDmoney bulk order-list review
 * table (LogMfTxCard's BulkReviewTable). Called right after parsing,
 * BEFORE the user has a chance to submit — lets the UI auto-uncheck
 * and flag rows that already have a matching ledger entry, instead of
 * relying purely on tx_hash collision at submit time.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE tx_hash UPSERT GUARD
 * ─────────────────────────────────────────────────────────
 * logMfTransaction()'s own dedup only fires when the derived NET
 * amount matches paisa-for-paisa. The bulk list only offers an
 * abbreviated amount ("₹10K") — for round-number purchases that reproduces
 * the exact same amount an earlier order-detail paste or manual entry
 * used, so the hash lines up and it's a safe no-op. But if the real
 * order wasn't a round number and INDmoney's display rounds it into
 * looking like one, the derived amount (and therefore the hash) can
 * come out slightly different from what's already on file — which
 * would silently insert a near-duplicate second row instead of being
 * recognized as the same trade. Matching on the WEAKER key
 * (fund_code, tx_date, tx_type) here — ignoring amount entirely —
 * catches that case up front, at the cost of also flagging the rare
 * legitimate "two separate purchases of the same fund on the same
 * day" case as "already on file" (already an accepted trade-off of
 * the hash design itself — see computeMfTxHash's doc comment).
 *
 * Studio TEST MODE rows (platform='test') are excluded — they are
 * rehearsal writes and must not block a real INDmoney paste.
 */
export async function checkExistingMfTx(
  candidates: Array<{
    fund_code: string;
    tx_date: string;
    tx_type: "purchase" | "redemption";
  }>
): Promise<
  Record<string, { amount: number; units: number; source: string } | null>
> {
  const result: Record<
    string,
    { amount: number; units: number; source: string } | null
  > = {};
  if (candidates.length === 0) return result;

  const fundCodes = Array.from(new Set(candidates.map((c) => c.fund_code)));
  const dates = candidates.map((c) => c.tx_date).sort();

  // Exclude Studio TEST MODE rows (platform='test'). Those are rehearsal
  // writes that intentionally skip fund_holdings / nw_daily bumps — but
  // they still land in mf_transactions. If we let them participate in
  // the weak-key check, a real INDmoney order for the same fund+date
  // shows "Fund+date already used" and auto-unchecks, so the genuine
  // trade never gets logged (and holdings drift vs the broker by that
  // amount). Strong-key (TxnID) matching is unaffected.
  const res = await sbServer
    .from("mf_transactions")
    .select("fund_code,tx_date,tx_type,amount,units,source,platform")
    .in("fund_code", fundCodes)
    .gte("tx_date", dates[0])
    .lte("tx_date", dates[dates.length - 1]);

  const rows = (res.error ? [] : (res.data ?? [])) as Array<{
    fund_code: string;
    tx_date: string;
    tx_type: string;
    amount: number | string;
    units: number | string;
    source: string;
    platform: string | null;
  }>;

  for (const c of candidates) {
    const key = `${c.fund_code}|${c.tx_date}|${c.tx_type}`;
    const match = rows.find(
      (r) =>
        r.fund_code === c.fund_code &&
        r.tx_date === c.tx_date &&
        r.tx_type === c.tx_type &&
        r.platform !== "test"
    );
    result[key] = match
      ? {
          amount: Math.abs(Number(match.amount)),
          units: Math.abs(Number(match.units)),
          source: match.source,
        }
      : null;
  }
  return result;
}

/**
 * STRONG-KEY pre-flight duplicate check for the INDmoney bulk-list
 * review table. Given a batch of source-side IDs (TxnIDs), returns a
 * map of ref → existing ledger row (or null if not on file yet).
 *
 * Companion of checkExistingMfTx (WEAK-key, matches on fund/date/type
 * only). The bulk table calls both in parallel and prefers the
 * strong match when present — deterministic, safe to trust as an
 * exact duplicate, versus the weak-key heuristic which merely says
 * "something else exists for this fund on this day, verify."
 */
export async function checkExistingMfTxByRef(
  source_refs: string[]
): Promise<
  Record<string, { amount: number; units: number; source: string; tx_date: string } | null>
> {
  const result: Record<
    string,
    { amount: number; units: number; source: string; tx_date: string } | null
  > = {};
  const refs = Array.from(
    new Set(source_refs.map((r) => r.trim()).filter((r) => r !== ""))
  );
  if (refs.length === 0) return result;

  const res = await sbServer
    .from("mf_transactions")
    .select("source_ref,amount,units,source,tx_date")
    .in("source_ref", refs);

  // Missing column (migration not applied yet) surfaces as a specific
  // Postgres error — fail soft, treat as "no matches on file" so the
  // UI stays functional and the user sees the fallback weak-key check
  // instead of a full-page error.
  if (res.error) {
    const code = (res.error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204") {
      console.warn(
        "[checkExistingMfTxByRef] source_ref column missing — apply " +
          "migration 2026-07-24-mf-transactions-source-ref.sql. " +
          "Falling back to weak-key check only."
      );
      for (const ref of refs) result[ref] = null;
      return result;
    }
    throw res.error;
  }

  const rows = (res.data ?? []) as Array<{
    source_ref: string;
    amount: number | string;
    units: number | string;
    source: string;
    tx_date: string;
  }>;
  for (const ref of refs) result[ref] = null;
  for (const r of rows) {
    result[r.source_ref] = {
      amount: Math.abs(Number(r.amount)),
      units: Math.abs(Number(r.units)),
      source: r.source,
      tx_date: r.tx_date,
    };
  }
  return result;
}

/**
 * Given a fund and a NAV value, find which trading day had that exact
 * NAV — used by the INDmoney bulk-list submit path to reconcile the
 * ambiguity between "placed date" (Subtitle1 in the JSON) and "NAV
 * date" (which INDmoney doesn't explicitly expose in bulk shape).
 *
 * The JSON only tells us Subtitle1 = "22 Jul 2026" (click date) and
 * Subtitle2 = "79.24 (Nav 126.20)" (allotted units + applied NAV).
 * Given that NAV number, `mf_nav_history` uniquely identifies which
 * trading day that NAV belongs to — post-cutoff orders naturally
 * resolve to a later date than the click, weekend orders resolve to
 * the following Monday, etc.
 *
 * MATCHING STRATEGY (three progressively stronger checks)
 * ───────────────────────────────────────────────────────
 * Level 1 — NAV value at 2 dp:
 *   Round both stored NAV (4 dp from AMFI) and INDmoney NAV (2 dp
 *   display) to 2 dp and compare. Search ±4-day window around the
 *   hint (weekends + one holiday). Handles the "126.20 display /
 *   126.2000 stored" precision mismatch cleanly.
 *
 * Level 2 — Units cross-check (only fires when >1 Level-1 match):
 *   INDmoney publishes reported units alongside the NAV. Back-derive
 *   expected units for each candidate day using its 4 dp stored NAV
 *   (units_expected = amount_net / stored_nav_4dp). A candidate whose
 *   back-derived 2 dp units matches INDmoney's reported 2 dp units is
 *   the true NAV date. This resolves the collision cleanly because
 *   even a ₹0.01 NAV drift moves derived units enough to swing the
 *   2 dp rounding — see the doc comment on this action for the worked
 *   example.
 *
 * Level 3 — Date-proximity tie-break (fallback):
 *   If units cross-check can't discriminate (either not provided by
 *   the caller, or multiple candidates all match the units), prefer
 *   dates ≥ hint_date (real post-cutoff orders always resolve later,
 *   never earlier), then pick the closest to the hint. Also logs a
 *   warning so the ambiguity surfaces in the dev-server output.
 *
 * Returns null when no Level-1 match — caller falls back to using
 * the hint date as tx_date (the pre-fix behavior). Non-null result
 * means at least one candidate matched at Level 1; the tie-break
 * chain above picked the best one.
 */
export async function resolveNavDate(
  fund_code: string,
  nav_value: number,
  hint_date: string,
  // Optional units + net-amount cross-check. Both must be provided
  // for Level 2 to fire. Passing just one has no effect (there's no
  // meaningful check with only units OR only amount). Callers that
  // don't have these (e.g. hand-typed manual form) omit both and the
  // resolver degrades to Level 1 + Level 3 only.
  units_reported?: number | null,
  amount_net?: number | null
): Promise<string | null> {
  if (!fund_code || !Number.isFinite(nav_value) || nav_value <= 0 || !hint_date) {
    return null;
  }

  const hintMs = Date.parse(hint_date);
  if (!Number.isFinite(hintMs)) return null;

  const dayMs = 86_400_000;
  const fromDate = new Date(hintMs - 4 * dayMs).toISOString().slice(0, 10);
  const toDate = new Date(hintMs + 4 * dayMs).toISOString().slice(0, 10);

  const res = await sbServer
    .from("mf_nav_history")
    .select("nav_date,nav")
    .eq("fund_code", fund_code)
    .gte("nav_date", fromDate)
    .lte("nav_date", toDate);

  if (res.error) {
    // Missing table — pre-migration or fresh install. Fail soft.
    const code = (res.error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205") return null;
    // Any other error: log + return null so the ingest doesn't hard-fail.
    console.warn(
      `[resolveNavDate] mf_nav_history query failed for ${fund_code}:`,
      res.error
    );
    return null;
  }

  const rows = (res.data ?? []) as Array<{ nav_date: string; nav: number | string }>;

  // ── Level 1: 2 dp NAV match ───────────────────────────────
  const target = Math.round(nav_value * 100) / 100;
  const matches = rows.filter((r) => {
    const stored = Math.round(Number(r.nav) * 100) / 100;
    return stored === target;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].nav_date;

  // ── Level 2: units cross-check ────────────────────────────
  // Fires only when both units + amount are available AND Level 1
  // gave us more than one candidate. Ranks candidates by how close
  // their back-derived 2 dp units are to what INDmoney reported;
  // returns the unique closest match if any.
  if (
    Number.isFinite(units_reported ?? NaN) &&
    Number.isFinite(amount_net ?? NaN) &&
    (units_reported ?? 0) > 0 &&
    (amount_net ?? 0) > 0
  ) {
    const targetUnits2dp = Math.round((units_reported as number) * 100) / 100;
    const scored = matches
      .map((m) => {
        const storedNav = Number(m.nav);
        if (!Number.isFinite(storedNav) || storedNav <= 0) return null;
        const derivedUnits = (amount_net as number) / storedNav;
        const derived2dp = Math.round(derivedUnits * 100) / 100;
        return {
          nav_date: m.nav_date,
          err: Math.abs(derived2dp - targetUnits2dp),
        };
      })
      .filter((s): s is { nav_date: string; err: number } => s != null)
      .sort((a, b) => a.err - b.err);
    // Strict winner — the top match is strictly closer than the
    // runner-up. Ties fall through to Level 3 (which will surface a
    // warning about the true ambiguity).
    if (scored.length > 0 && (scored.length === 1 || scored[0].err < scored[1].err)) {
      return scored[0].nav_date;
    }
  }

  // ── Level 3: date-proximity tie-break + audit log ─────────
  // Surface the ambiguity in the dev logs so we can spot cases
  // where the cross-check couldn't disambiguate. Post-cutoff
  // rolling still applies (dates ≥ hint preferred), then proximity.
  console.warn(
    `[resolveNavDate] ${matches.length} candidate NAV dates for ` +
      `${fund_code} @ NAV ${target} (hint ${hint_date}): ${matches
        .map((m) => m.nav_date)
        .join(", ")}. Falling back to date proximity — verify in the ` +
      `review table before submitting.`
  );
  matches.sort((a, b) => {
    const aTs = Date.parse(a.nav_date);
    const bTs = Date.parse(b.nav_date);
    const aFuture = aTs >= hintMs;
    const bFuture = bTs >= hintMs;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return Math.abs(aTs - hintMs) - Math.abs(bTs - hintMs);
  });
  return matches[0].nav_date;
}

export async function saveRotation(input: {
  Mon: string;
  Tue: string;
  Wed: string;
  Thu: string;
  Fri: string;
}): Promise<ActionResult> {
  try {
    const { error } = await sbServer.from("portfolio_config").upsert(
      {
        key: "v5_rotation",
        value: JSON.stringify(input),
        description: "V5 daily rotation schedule",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
    if (error) throw error;
    // Rotation is a schedule for future deployments — no NW impact today.
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return err(e);
  }
}

/**
 * Purge every Studio rehearsal row (`platform = 'test'`) from
 * mf_transactions. These rows never bump fund_holdings / nw_daily, so
 * no recompute is needed — just delete + revalidate studio/sync
 * surfaces that list the ledger.
 *
 * Wired to the Sync page "Delete all test data" button so you don't
 * need a one-off SQL sweep after recording sessions.
 */
export async function deleteStudioTestData(): Promise<
  { ok: true; deleted: number } | { ok: false; error: string }
> {
  try {
    const { data, error } = await sbServer
      .from("mf_transactions")
      .delete()
      .eq("platform", "test")
      .select("id");
    if (error) throw error;

    const deleted = data?.length ?? 0;
    revalidatePath("/sync");
    revalidatePath("/studio", "layout");
    return { ok: true, deleted };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
