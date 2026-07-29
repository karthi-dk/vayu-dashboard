"use client";

import { useMemo, useState, useTransition } from "react";
import {
  BookOpen,
  CheckCircle2,
  AlertTriangle,
  Info,
  Loader2,
  ClipboardPaste,
  ChevronDown,
  ChevronUp,
  ListChecks,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn, fmtDate, fmtINR } from "@/lib/utils";
import {
  logMfTransaction,
  checkExistingMfTx,
  checkExistingMfTxByRef,
  resolveNavDate,
} from "@/app/actions";
import { parseIndmoneyOrderJson } from "@/lib/mf/parseIndmoneyOrder";
import {
  parseIndmoneyTransactionsList,
  type ParsedIndmoneyListItem,
} from "@/lib/mf/parseIndmoneyTransactionsList";
import { PLATFORMS, type PlatformCode } from "@/lib/mf/platform";

/**
 * Log one MF transaction that happened outside Groww's platform —
 * primarily for AMC-direct SIPs (ICICI Prudential app for
 * ICICI_NASDAQ, HDFC app, Nippon app, etc.) which never flow
 * through Groww's order feed and would otherwise vanish from the
 * dashboard until an eventual CAS re-paste.
 *
 * Companion of GrowwPasteCard: Groww handles Groww orders, this
 * handles everything else. Both feed the same union'd MF ledger via
 * getMfLedgerEntries().
 *
 * WHY NOT JUST WAIT FOR CAS?
 * ──────────────────────────
 * MFCentral eCAS refreshes on-demand but the paste UI was retired
 * (per the July 2026 cleanup). Even if we restore it, the user
 * doesn't want to wait 2–3 months for the SIP to show up in the
 * dashboard — real-time visibility matters for cap-ratio tracking.
 * This card fills the gap.
 *
 * WHY THE HASH FORMULA MATTERS
 * ────────────────────────────
 * The server action computes `tx_hash` deterministically from
 * (fund_code, tx_date, tx_type, amount, units). If MFCentral CAS is
 * ever restored, its parser can use the SAME formula → same trade
 * produces same hash → the DB upsert merges the two into a single
 * row automatically, no dedup logic needed at read time. See
 * lib/mf/logMfTx.ts for full rationale.
 */

type FormState = {
  fund_code: string;
  tx_date: string;
  tx_type: "purchase" | "redemption";
  amount_inr: string;
  // true = "NAV date same as transaction date" (the default, and the
  // overwhelming common case). When false, nav_date holds an explicit
  // override for orders placed after cutoff (T+1 NAV) or any other case
  // where the NAV-applied date genuinely differs from the order date.
  nav_date_same: boolean;
  nav_date: string;
  nav_override: string;
  description_note: string;
  // Populated only when the form was autofilled from an INDmoney
  // order-detail paste (carries that order's TxnID as source_ref for
  // deterministic dedup). Empty for hand-typed manual entries — those
  // still fall back to the tx_hash idempotency guarantee. Never
  // rendered — it's a hidden provenance field.
  source_ref: string;
  // Purchase platform — WHERE the order was actually placed. Sticky
  // across submits so a repeat direct-AMC SIP doesn't need re-picking.
  // Autofilled to 'indmoney' when an INDmoney JSON is pasted.
  platform: PlatformCode;
};

// One row of the bulk-list review table. Carries the parsed facts
// (`item`) plus everything the UI needs to let the user confirm/edit
// before submitting — critically the amount, which parseIndmoneyTransactionsList
// deliberately does NOT resolve on its own (see that module's header
// comment for the precision-mismatch reasoning).
//
// DATE FIELDS — WHY TWO OF THEM
// ─────────────────────────────
// INDmoney's bulk-list payload conflates two distinct dates into
// Subtitle1's "Order Date":
//   • placedDate: when the user clicked Buy (in their local time). This
//     is what Subtitle1 literally contains.
//   • txDate: the day whose NAV was actually applied to allot units.
//     For a pre-cutoff order this equals placedDate; for a post-3PM-
//     cutoff order it's the next trading day.
// The parser can't tell the two apart from the JSON alone (Subtitle1
// is just a date string, no time-of-day, no cutoff flag). We derive
// txDate at parse time via a NAV-value lookup against mf_nav_history:
// given fund_code + the NAV value from Subtitle2, exactly one trading
// day near placedDate will have that NAV, and that's the true NAV
// date. If the lookup can't find a match (mf_nav_history not yet
// backfilled for that day, or NAV number doesn't uniquely identify a
// day), txDate falls back to placedDate — the pre-fix behavior — and
// the user can nudge it in the review table.
type BulkRow = {
  key: string;
  item: ParsedIndmoneyListItem;
  checked: boolean;
  fundCode: string;
  // NAV date (day whose NAV was applied). User-editable via the date
  // input in the review table. Auto-derived from resolveNavDate() at
  // parse time when possible.
  txDate: string;
  // Click date (INDmoney Subtitle1). NOT user-editable — this is a
  // record of what the user did, not a variable the system should
  // let them rewrite. Null means "same as txDate" (T+0 order) and
  // will be omitted from the DB via the placed_date column's null-
  // means-collapse convention.
  placedDate: string | null;
  amountInput: string;
  submitState: "idle" | "pending" | "ok" | "error";
  submitMessage: string | null;
  // undefined = pre-flight checks haven't resolved yet;
  // null = both checks came back clean, safe to log;
  // object = a matching ledger row was found — `matchedBy` tells us
  //   how confidently ('source_ref' = deterministic same-order match
  //   via INDmoney TxnID, safe to skip; 'weak_key' = same fund+date+
  //   type match, could be a legitimate second trade same day, verify
  //   before deciding).
  existingMatch:
    | {
        amount: number;
        units: number;
        source: string;
        matchedBy: "source_ref" | "weak_key";
      }
    | null
    | undefined;
};

// Local mirror of the fund set. Kept in-sync manually because pulling
// from lib/fundIsin.ts would bring the Record type + reverse-map
// definitions into the client bundle; the redundancy here is a small
// price for a leaner component.
const FUND_OPTIONS = [
  { code: "ICICI_NASDAQ", label: "ICICI NASDAQ 100" },
  { code: "PPFAS_FC", label: "PPFAS Flexi Cap" },
  { code: "PPFAS_CH", label: "PPFAS Conservative Hybrid" },
  { code: "HDFC_FC", label: "HDFC Flexi Cap" },
  { code: "HDFC_SC", label: "HDFC Small Cap" },
  { code: "HDFC_STD", label: "HDFC Short Term Debt" },
  { code: "UTI_N50", label: "UTI Nifty 50" },
  { code: "UTI_NN50", label: "UTI Nifty Next 50" },
  { code: "NIPPON_MID", label: "Nippon India Growth Mid Cap" },
  { code: "EDEL_MID", label: "Edelweiss Mid Cap" },
] as const;

export function LogMfTxCard() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<FormState>({
    // Default to ICICI_NASDAQ — currently the only fund with a
    // known direct-AMC SIP running (₹10K monthly). Trivially
    // changed via the dropdown if the user later adds another
    // non-Groww SIP.
    fund_code: "ICICI_NASDAQ",
    tx_date: todayIso,
    tx_type: "purchase",
    amount_inr: "",
    nav_date_same: true,
    nav_date: todayIso,
    nav_override: "",
    description_note: "",
    source_ref: "",
    // Default to ICICI Prudential — matches the ICICI_NASDAQ fund
    // default above (the primary direct-AMC SIP this form was built
    // for). Trivially changed via the dropdown.
    platform: "icici_prudential",
  });
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<
    | { ok: true; message: string; details: string }
    | { ok: false; message: string }
    | null
  >(null);

  // ── INDmoney paste-and-autofill ──────────────────────────────────
  // Collapsed by default — this is a shortcut for the specific
  // "pasting from INDmoney's order-detail screen" workflow, not the
  // primary path (direct-AMC entries are still typed by hand). See
  // lib/mf/parseIndmoneyOrder.ts for why this is a label-matching
  // parser rather than a schema parser — INDmoney's payload is a UI
  // widget tree, not a stable data API.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteFeedback, setPasteFeedback] = useState<
    | { ok: true; message: string; warnings: string[] }
    | { ok: false; message: string }
    | null
  >(null);

  // ── Bulk order-history list (a DIFFERENT INDmoney payload shape) ──
  // The order-detail paste above handles ONE order's txnStatus JSON.
  // This handles the order-HISTORY list JSON, which covers many orders
  // in one paste and — once an order settles — carries exact units +
  // NAV, not just the rounded "Buy Amount" the detail screen has. See
  // lib/mf/parseIndmoneyTransactionsList.ts for why the amount field
  // here still needs a human glance before submitting (display-
  // rounding on both the abbreviated "₹10K" amount AND the 2dp units
  // means neither reconstructs the exact net amount the order-detail
  // screen would show — closest available, not authoritative).
  const [bulkRows, setBulkRows] = useState<BulkRow[] | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  function handleParsePaste() {
    if (pasteText.trim() === "") {
      setPasteFeedback({ ok: false, message: "Paste INDmoney JSON first." });
      return;
    }

    // Detect shape before committing to a parser: does this look like
    // the bulk order-history list (data.transactions[]) or a single
    // order's detail screen? A cheap parse-and-peek rather than trying
    // one parser and falling back — avoids two different "invalid
    // JSON" error paths fighting over which message to show.
    let quick: unknown = null;
    try {
      quick = JSON.parse(pasteText);
    } catch {
      // fall through — parseIndmoneyOrderJson below will surface the
      // same "invalid JSON" error with a proper message.
    }
    const looksLikeList = Array.isArray(
      (quick as { data?: { transactions?: unknown } } | null)?.data?.transactions
    );

    if (looksLikeList) {
      const result = parseIndmoneyTransactionsList(pasteText);
      if (!result.ok) {
        setBulkRows(null);
        setPasteFeedback({ ok: false, message: result.error });
        return;
      }

      // Bucket by outcome — only "successful" orders become actionable
      // rows. Everything else stays as a summary count with an optional
      // warning line, because:
      //   • in-progress → units aren't allotted yet, no NAV to record;
      //     the same TxnID will reappear as successful in a later
      //     paste once it settles (strong-key pre-flight recognizes it
      //     as new because we didn't log the in-progress version).
      //   • cancelled/failed → no money moved, so nothing belongs in
      //     the ledger at all.
      //   • unknown → status string we haven't classified; hide the
      //     row but surface as a warning so a new INDmoney status
      //     doesn't get silently swallowed.
      const buckets = {
        successful: [] as ParsedIndmoneyListItem[],
        in_progress: [] as ParsedIndmoneyListItem[],
        cancelled: [] as ParsedIndmoneyListItem[],
        failed: [] as ParsedIndmoneyListItem[],
        unknown: [] as ParsedIndmoneyListItem[],
      };
      for (const item of result.items) buckets[item.outcome].push(item);

      const rows: BulkRow[] = buckets.successful.map((item, idx) => ({
        key: `${item.txn_id ?? "row"}-${idx}`,
        item,
        checked: true,
        fundCode: item.fund_code ?? "",
        // txDate initially seeds from Subtitle1 (order/placed date) —
        // it'll get overwritten by resolveNavDate() below when the NAV
        // value from Subtitle2 uniquely identifies a different trading
        // day. If the lookup fails (mf_nav_history not populated for
        // that fund/day), the txDate stays on placedDate and the user
        // can nudge it in the review table.
        txDate: item.order_date ?? todayIso,
        placedDate: item.order_date ?? null,
        amountInput: (item.parsed_amount ?? item.net_from_units ?? "").toString(),
        submitState: "idle",
        submitMessage: null,
        existingMatch: undefined,
      }));

      const summaryParts = [`${result.items.length} order(s) parsed`];
      if (buckets.successful.length > 0)
        summaryParts.push(`${buckets.successful.length} successful (below)`);
      if (buckets.in_progress.length > 0)
        summaryParts.push(
          `${buckets.in_progress.length} in-progress (log after allotment)`
        );
      if (buckets.cancelled.length > 0)
        summaryParts.push(`${buckets.cancelled.length} cancelled (skipped)`);
      if (buckets.failed.length > 0)
        summaryParts.push(`${buckets.failed.length} failed (skipped)`);
      if (buckets.unknown.length > 0)
        summaryParts.push(`${buckets.unknown.length} unrecognized status`);

      const warnings: string[] = [];
      for (const r of rows) {
        if (!r.fundCode) {
          warnings.push(
            `Couldn't match "${r.item.fund_name_raw}" — pick its fund manually.`
          );
        }
      }
      // Surface the raw status strings for anything we couldn't
      // classify — the user can screenshot this and file it upstream
      // rather than the row silently disappearing.
      for (const u of buckets.unknown) {
        warnings.push(
          `Unrecognized status "${u.raw_status}" (TxnID ${u.txn_id ?? "?"}) — please report so we can classify it.`
        );
      }

      setBulkRows(rows.length > 0 ? rows : null);
      setPasteFeedback({
        ok: true,
        message: summaryParts.join(" · "),
        warnings,
      });
      if (rows.length > 0) {
        // Two independent async passes fired in parallel:
        //   1. runNavDateResolution — updates txDate for post-cutoff
        //      rows so the ledger records the actual NAV date, not the
        //      user-facing click date.
        //   2. runExistingCheck    — pre-flight duplicate detection.
        // Order matters SLIGHTLY: NAV-date resolution changes txDate
        // for a subset of rows, and the weak-key duplicate check keys
        // on txDate. Running the checks in parallel means the weak-key
        // check MAY use the pre-resolution date — that's fine because
        // the strong-key check (source_ref/TxnID) is deterministic and
        // wins over the weak-key one, and the weak-key check only
        // fires when there's no TxnID at all (essentially never for
        // INDmoney bulk-list rows, which all carry TxnID).
        void runNavDateResolution(rows);
        void runExistingCheck(rows);
      }
      return;
    }

    setBulkRows(null);
    const parsed = parseIndmoneyOrderJson(pasteText);

    // Even a partial parse is useful — fill whatever we found and let
    // the warnings tell the user what still needs a manual look. Only
    // treat it as a hard failure when NOTHING useful came out (no
    // amount AND no date AND no fund match).
    const gotNothing =
      parsed.gross_amount == null && parsed.order_date == null && !parsed.fund_code;
    if (gotNothing) {
      setPasteFeedback({
        ok: false,
        message: `Couldn't extract anything usable. ${parsed.warnings.join(" ")}`,
      });
      return;
    }

    setForm((prev) => {
      const next = { ...prev };
      if (parsed.fund_code) next.fund_code = parsed.fund_code;
      next.tx_type = parsed.tx_type;
      if (parsed.order_date) next.tx_date = parsed.order_date;
      if (parsed.gross_amount != null) {
        next.amount_inr = parsed.gross_amount.toString();
      }
      // NAV date wiring — mirrors the manual checkbox's semantics
      // exactly: differs → uncheck + populate the override; same (or
      // unknown) → leave checked, which defaults the server lookup to
      // tx_date anyway.
      if (parsed.nav_date_differs && parsed.nav_date) {
        next.nav_date_same = false;
        next.nav_date = parsed.nav_date;
      } else {
        next.nav_date_same = true;
        next.nav_date = parsed.order_date ?? prev.tx_date;
      }
      // Compose a traceable note from whatever identifiers we found —
      // folio / payment mode / holding type aren't form fields in
      // their own right, so this is the only place they'd otherwise
      // survive. Order ID also flows into source_ref below so the
      // ledger dedup can key on it deterministically.
      const noteParts = [
        parsed.order_id ? `INDmoney order ${parsed.order_id}` : "INDmoney order",
        parsed.folio ? `Folio ${parsed.folio}` : null,
        parsed.payment_mode,
        parsed.holding_type === "Physical" ? "SOA" : parsed.holding_type,
      ].filter(Boolean);
      next.description_note = noteParts.join(" · ");
      next.source_ref = parsed.order_id ?? "";
      next.platform = "indmoney";
      return next;
    });

    setPasteFeedback({
      ok: true,
      message: parsed.fund_code
        ? `Filled form from "${parsed.fund_name_raw ?? parsed.fund_code}"`
        : `Filled amount/date, but couldn't match the fund — pick it from the dropdown below.`,
      warnings: parsed.warnings,
    });
  }

  /** Pre-flight duplicate check — runs once right after parsing, before
   *  the user can submit. Two lookups fired in parallel:
   *    1) STRONG match by INDmoney TxnID (source_ref) — deterministic.
   *    2) WEAK match by (fund_code, tx_date, tx_type) — heuristic.
   *  Strong wins when both hit. Rows with any match auto-uncheck so
   *  idempotency doesn't hinge on the amount happening to hash-collide
   *  at submit time. See checkExistingMfTxByRef / checkExistingMfTx in
   *  app/actions.ts for the full rationale. */
  async function runExistingCheck(initialRows: BulkRow[]) {
    const successful = initialRows.filter(
      (r) => r.item.outcome === "successful" && r.fundCode
    );
    if (successful.length === 0) return;

    const refs = successful
      .map((r) => r.item.txn_id)
      .filter((id): id is string => !!id && id.trim() !== "");

    const strongPromise: ReturnType<typeof checkExistingMfTxByRef> =
      refs.length > 0 ? checkExistingMfTxByRef(refs) : Promise.resolve({});
    const [strongMatches, weakMatches] = await Promise.all([
      strongPromise,
      checkExistingMfTx(
        successful.map((r) => ({
          fund_code: r.fundCode,
          tx_date: r.txDate,
          tx_type: r.item.tx_type,
        }))
      ),
    ]);

    setBulkRows((prev) => {
      if (!prev) return prev;
      return prev.map((r) => {
        if (r.item.outcome !== "successful" || !r.fundCode) {
          return r.existingMatch === undefined ? { ...r, existingMatch: null } : r;
        }
        // Prefer the strong (TxnID) match — deterministic, no
        // false positives. Fall back to the weak (fund/date/type)
        // match only when no source-ref lookup fired or came up empty.
        const strong = r.item.txn_id ? strongMatches[r.item.txn_id.trim()] : null;
        const weakKey = `${r.fundCode}|${r.txDate}|${r.item.tx_type}`;
        const weak = weakMatches[weakKey] ?? null;

        const match: BulkRow["existingMatch"] = strong
          ? { ...strong, matchedBy: "source_ref" }
          : weak
            ? { ...weak, matchedBy: "weak_key" }
            : null;

        return {
          ...r,
          existingMatch: match,
          // Auto-uncheck any match — user can still re-check manually if
          // they know this is a genuinely distinct second trade
          // (extremely unusual for the strong match; more plausible for
          // the weak match's "two purchases of same fund same day" case).
          checked: match ? false : r.checked,
        };
      });
    });
  }

  /**
   * Resolve each row's NAV date from mf_nav_history — the fix for the
   * INDmoney bulk-list Subtitle1 ambiguity discussed in BulkRow's doc
   * comment above. For rows where INDmoney supplied a NAV value in
   * Subtitle2 and the fund is matched, ask the server "given this fund
   * and this NAV, which trading day's NAV was it?" — a post-cutoff
   * order resolves to the next trading day, a Friday-evening order
   * resolves to Monday, etc. When the lookup succeeds AND changes the
   * date, we update txDate in-place; placedDate (Subtitle1) stays
   * unchanged so both dates end up correctly recorded.
   *
   * Fired IN PARALLEL with runExistingCheck — both are read-only and
   * update independent slices of the row (txDate vs existingMatch).
   */
  async function runNavDateResolution(initialRows: BulkRow[]) {
    const resolvable = initialRows.filter(
      (r) =>
        r.item.outcome === "successful" &&
        r.fundCode &&
        r.item.nav != null &&
        r.item.order_date != null
    );
    if (resolvable.length === 0) return;

    // Sequential lookups rather than Promise.all — each is a fast
    // indexed query, and serializing keeps the "which fund's NAV
    // failed?" trace legible if any single one throws. Bulk sizes
    // are small (typically ≤10 rows per paste).
    //
    // Pass units + net_from_units too — resolveNavDate uses them as a
    // Level-2 cross-check when the 2 dp NAV value alone matches more
    // than one trading day (mostly happens for range-bound debt /
    // arbitrage / liquid funds whose day-over-day moves are smaller
    // than the 2 dp INDmoney publishes). Back-deriving expected units
    // from each candidate day's 4 dp stored NAV disambiguates cleanly
    // because unit drift dominates NAV drift at this precision. See
    // the resolveNavDate doc comment for the worked example.
    const resolved = new Map<string, string>();
    for (const r of resolvable) {
      try {
        const derived = await resolveNavDate(
          r.fundCode,
          r.item.nav!,
          r.item.order_date!,
          r.item.units,
          r.item.net_from_units
        );
        if (derived && derived !== r.item.order_date) {
          resolved.set(r.key, derived);
        }
      } catch (e) {
        // Silent — a single row's NAV resolution failing is not a
        // user-facing error; the row falls back to Subtitle1 as the
        // NAV date (pre-fix behavior), and the user can still edit it
        // in the review table.
        console.warn(
          `[LogMfTxCard] resolveNavDate failed for ${r.fundCode}:`,
          e
        );
      }
    }
    if (resolved.size === 0) return;

    setBulkRows((prev) => {
      if (!prev) return prev;
      return prev.map((r) => {
        const newDate = resolved.get(r.key);
        return newDate ? { ...r, txDate: newDate } : r;
      });
    });
  }

  function updateBulkRow(key: string, patch: Partial<BulkRow>) {
    setBulkRows((prev) =>
      prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev
    );
  }

  async function handleBulkSubmit() {
    if (!bulkRows || bulkPending) return;
    const toSubmit = bulkRows.filter((r) => r.checked);
    if (toSubmit.length === 0) return;

    setBulkPending(true);
    // Sequential, not Promise.all — keeps per-row status updates
    // legible as they land, and avoids hammering mfapi.in with N
    // simultaneous NAV lookups for what's usually a handful of rows.
    for (const row of toSubmit) {
      updateBulkRow(row.key, { submitState: "pending", submitMessage: null });

      if (!row.fundCode) {
        updateBulkRow(row.key, {
          submitState: "error",
          submitMessage: "Select a fund first",
        });
        continue;
      }
      const amt = Number(row.amountInput.replace(/[,\s]/g, ""));
      if (!Number.isFinite(amt) || amt <= 0) {
        updateBulkRow(row.key, {
          submitState: "error",
          submitMessage: "Invalid amount",
        });
        continue;
      }

      const noteParts = [
        row.item.txn_id ? `INDmoney order ${row.item.txn_id}` : "INDmoney order",
        row.item.units != null && row.item.nav != null
          ? `list-reported ${row.item.units}u @ NAV ${row.item.nav}`
          : null,
      ].filter(Boolean);

      const result = await logMfTransaction({
        fund_code: row.fundCode,
        // txDate is the NAV date after runNavDateResolution has run —
        // matches the CAS convention where the "transaction date" is
        // the day whose NAV was applied. See BulkRow doc comment.
        tx_date: row.txDate,
        tx_type: row.item.tx_type,
        amount_inr: amt,
        // No separate nav_date override needed — txDate IS the NAV
        // date. Passing nav_date: null keeps the server-side default
        // (navLookupTarget = tx_date) which is exactly what we want.
        nav_date: null,
        // INDmoney's own reported NAV is authoritative — it's what the
        // AMC actually applied. Passing it as an override skips the
        // mfapi.in fetch entirely (which was the pre-fix bug: parsed
        // JSON already had "79.24 (Nav 126.20)" in Subtitle2 but the
        // submit path re-fetched from mfapi and could fail when mfapi
        // lagged AMFI by a few hours for the just-happened order).
        // Falls back to server-side mfapi lookup on the rare case where
        // parseUnitsAndNav couldn't extract a NAV from Subtitle2.
        nav_override: row.item.nav,
        nav_source_label: "indmoney",
        description_note: noteParts.join(" · "),
        // Deterministic same-order idempotency — see migration
        // 2026-07-24-mf-transactions-source-ref.sql and the strong-
        // key early-return in logMfTransaction.
        source_ref: row.item.txn_id,
        // Bulk-list rows always come from INDmoney by definition —
        // that's the only ingest path that produces this JSON shape.
        platform: "indmoney",
        // placedDate = INDmoney Subtitle1 (user's click date).
        // Server-side logMfTransaction only writes the column when
        // placed_date != tx_date, so same-day T+0 rows silently fold
        // to a single-line ledger display via the "null means collapse"
        // convention.
        placed_date: row.placedDate,
      });

      updateBulkRow(row.key, {
        submitState: result.ok ? "ok" : "error",
        submitMessage: result.ok
          ? result.duplicate
            ? "Already on file"
            : `Logged · ${result.units.toFixed(4)}u @ NAV ${result.nav.toFixed(4)}`
          : result.error,
      });
    }
    setBulkPending(false);
  }

  // Preview of stamp duty + net amount so the user knows exactly
  // what will land in the DB before submitting. Zero cognitive
  // overhead compared to "why did my ₹10,000 SIP show as ₹9,999.50?"
  const grossParsed = Number(form.amount_inr.replace(/[,\s]/g, ""));
  const preview = useMemo(() => {
    if (!Number.isFinite(grossParsed) || grossParsed <= 0) return null;
    if (form.tx_type === "redemption") {
      return { stampDuty: 0, netAmount: grossParsed };
    }
    // 0.005% stamp duty on purchases (SEBI 2020). Mirrors
    // stampDutyForPurchase() on the server so client + server agree
    // on the preview and the recorded amount.
    const duty = Math.round(grossParsed * 0.00005 * 100) / 100;
    return { stampDuty: duty, netAmount: Number((grossParsed - duty).toFixed(2)) };
  }, [grossParsed, form.tx_type]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Keep nav_date silently mirroring tx_date while the "same date"
      // checkbox is on — so if the user unchecks it a moment later, the
      // NAV date field starts pre-filled with the transaction date
      // instead of blank, and they only need to nudge it (usually +1 day)
      // rather than retype it from scratch.
      if (key === "tx_date" && prev.nav_date_same) {
        next.nav_date = value as string;
      }
      return next;
    });
    setFeedback(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!Number.isFinite(grossParsed) || grossParsed <= 0) {
      setFeedback({ ok: false, message: "Enter a valid amount." });
      return;
    }
    const navOverride =
      form.nav_override.trim() === "" ? null : Number(form.nav_override);
    if (
      navOverride != null &&
      (!Number.isFinite(navOverride) || navOverride <= 0)
    ) {
      setFeedback({ ok: false, message: "NAV override must be a positive number, or leave blank to auto-fetch from mfapi.in." });
      return;
    }
    startTransition(async () => {
      const result = await logMfTransaction({
        fund_code: form.fund_code,
        tx_date: form.tx_date,
        tx_type: form.tx_type,
        amount_inr: grossParsed,
        // Omit nav_date entirely when the checkbox is on — server
        // defaults to tx_date, identical to pre-checkbox behavior.
        // Only send an explicit value once the user has flagged the
        // NAV date as genuinely different.
        nav_date: form.nav_date_same ? null : form.nav_date,
        nav_override: navOverride,
        description_note:
          form.description_note.trim() === ""
            ? null
            : form.description_note.trim(),
        // Populated by the INDmoney order-detail autofill above (empty
        // for hand-typed entries — those still get tx_hash idempotency
        // only, which is the pre-existing behavior).
        source_ref: form.source_ref.trim() === "" ? null : form.source_ref.trim(),
        platform: form.platform,
      });
      if (!result.ok) {
        setFeedback({ ok: false, message: result.error });
        return;
      }
      const dateStr = fmtDate(result.nav_date);
      const message = result.duplicate
        ? `Already on file (idempotent no-op)`
        : `Recorded — ${form.fund_code} ${form.tx_type}`;
      const details = `${fmtINR(result.amount)} @ NAV ${result.nav.toFixed(
        4
      )} on ${dateStr} = ${result.units.toFixed(4)} units${
        result.duplicate
          ? " · same hash as an existing row, nothing changed"
          : ""
      }`;
      setFeedback({ ok: true, message, details });
      // Reset amount so a quick repeat next month starts blank, but
      // leave fund/date defaults so the user can log the next SIP
      // with two clicks (change date, retype amount). NAV-date-same
      // resets to checked (the common case) + re-synced to tx_date —
      // a T+1 override was almost certainly a one-off for that specific
      // order, not something that should silently carry into the next
      // entry.
      setForm((prev) => ({
        ...prev,
        amount_inr: "",
        nav_date_same: true,
        nav_date: prev.tx_date,
        nav_override: "",
        description_note: "",
        // A TxnID belongs to exactly one order — always clear after
        // submit so the next entry doesn't accidentally reuse a stale
        // source_ref from an earlier paste. Platform stays sticky
        // (unlike source_ref, it's a mode-of-operation, not per-order).
        source_ref: "",
      }));
    });
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted/50 p-2">
          <BookOpen size={16} className="text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              Log MF transaction (direct AMC)
            </h2>
            <span
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Purchases through an AMC's own app (ICICI Prudential, HDFC MF, etc.) never flow through Groww, so this card records them directly into the MF ledger. Same table as CAS ingestion — hash is deterministic so a future CAS re-paste won't duplicate."
            >
              non-Groww
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Records into <code className="font-mono">mf_transactions</code>{" "}
            with a deterministic hash — safe to re-submit the same SIP,
            aligned with any future CAS re-paste.
          </p>
        </div>
      </div>

      {/* INDmoney paste-and-autofill — collapsed by default. Accepts
          EITHER of INDmoney's two useful JSON shapes, auto-detected:
            • order-history LIST (data.transactions[]) — many orders at
              once; renders a review table below (bulk mode).
            • single order's DETAIL/txnStatus screen — fills the form
              below directly (single mode), still the better source for
              an in-progress order's folio/payment-mode.
          See lib/mf/parseIndmoneyOrder.ts and
          lib/mf/parseIndmoneyTransactionsList.ts for why both are
          label-matching parsers (fragile against INDmoney UI
          reshuffles) rather than schema parsers. */}
      <button
        type="button"
        onClick={() => setPasteOpen((o) => !o)}
        className="mt-3 flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/20"
      >
        <span className="inline-flex items-center gap-1.5">
          <ClipboardPaste size={12} />
          Paste from INDmoney (order list or order-detail JSON)
        </span>
        {pasteOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {pasteOpen && (
        <div className="mt-2 rounded-md border border-border/60 bg-muted/10 p-3">
          <textarea
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteFeedback(null);
            }}
            disabled={pending}
            placeholder="Paste either the order-history LIST JSON or a single order's order-status (txnStatus) JSON…"
            rows={4}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleParsePaste}
              disabled={pending}
            >
              Parse
            </Button>
            {pasteFeedback && (
              <div
                className={cn(
                  "flex-1 text-[11px]",
                  pasteFeedback.ok
                    ? "text-[hsl(var(--success))]"
                    : "text-[hsl(var(--danger))]"
                )}
              >
                {pasteFeedback.message}
                {pasteFeedback.ok && pasteFeedback.warnings.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-muted-foreground">
                    {pasteFeedback.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {bulkRows && (
            <BulkReviewTable
              rows={bulkRows}
              pending={bulkPending}
              onToggle={(key, checked) => updateBulkRow(key, { checked })}
              onFundChange={(key, fundCode) => updateBulkRow(key, { fundCode })}
              onDateChange={(key, txDate) => updateBulkRow(key, { txDate })}
              onAmountChange={(key, amountInput) => updateBulkRow(key, { amountInput })}
              onSubmit={handleBulkSubmit}
            />
          )}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {/* Fund selector — dropdown of all known funds. Native <select> keeps
            bundle lean and matches the LogCreditEventCard pattern. */}
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Fund</span>
          <select
            value={form.fund_code}
            onChange={(e) => updateField("fund_code", e.target.value)}
            disabled={pending}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {FUND_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.label} ({opt.code})
              </option>
            ))}
          </select>
        </label>

        {/* Transaction type — purchase (default) or redemption. Switches
            are deliberately excluded — those only happen through an AMC
            app for lifecycle transfers and are rare enough that manual
            entry via a switch-specific tool is a fair ask. */}
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">Type</span>
          <select
            value={form.tx_type}
            onChange={(e) =>
              updateField("tx_type", e.target.value as "purchase" | "redemption")
            }
            disabled={pending}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="purchase">Purchase</option>
            <option value="redemption">Redemption</option>
          </select>
        </label>

        {/* Platform — WHERE the order was actually placed. Distinct
            from where THIS ENTRY came from (that's the ingest source,
            captured server-side). Autofilled to 'indmoney' when an
            INDmoney JSON was pasted above. Sticky across submits so a
            repeat direct-AMC SIP doesn't need re-picking. */}
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="font-medium text-foreground">Platform</span>
          <select
            value={form.platform}
            onChange={(e) =>
              updateField("platform", e.target.value as PlatformCode)
            }
            disabled={pending}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {PLATFORMS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {/* Date — defaults to today. YYYY-MM-DD via native date picker
            (Chrome/Safari render as calendar). Wrapping <div>, not
            <label> — a nested <label> for the checkbox below would be
            invalid HTML (labels can't nest). */}
        <div className="flex flex-col gap-1 text-xs">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Transaction date</span>
            <Input
              type="date"
              value={form.tx_date}
              onChange={(e) => updateField("tx_date", e.target.value)}
              disabled={pending}
              max={todayIso}
            />
          </label>
          <label className="mt-1 flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
            <input
              type="checkbox"
              checked={form.nav_date_same}
              onChange={(e) => updateField("nav_date_same", e.target.checked)}
              disabled={pending}
              className="h-3 w-3 rounded border-input"
            />
            NAV date same as transaction date
          </label>
        </div>

        {/* NAV date override — only shown once the checkbox above is
            unchecked. Covers orders placed after the AMC's cutoff
            (typically 3 PM for equity funds), which get the NEXT
            trading day's NAV, not the order date's. Pre-filled with
            tx_date so the user usually just nudges it by a day rather
            than typing from scratch (see updateField's mirroring). */}
        {!form.nav_date_same && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-foreground">
              NAV date{" "}
              <span className="font-normal text-muted-foreground">
                (the date whose NAV actually applied — e.g. T+1 if placed
                after cutoff)
              </span>
            </span>
            <Input
              type="date"
              value={form.nav_date}
              onChange={(e) => updateField("nav_date", e.target.value)}
              disabled={pending}
              max={todayIso}
            />
          </label>
        )}

        {/* Gross amount — what user told the AMC to invest. Server
            deducts stamp duty and records the net. */}
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground">
            Gross amount (₹)
          </span>
          <Input
            type="text"
            inputMode="decimal"
            value={form.amount_inr}
            onChange={(e) => updateField("amount_inr", e.target.value)}
            placeholder="10,000"
            disabled={pending}
          />
        </label>

        {/* NAV override — optional. Empty = auto-fetch from mfapi.in
            for the transaction date (walking back to nearest published
            NAV if that date is a weekend/holiday). */}
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="font-medium text-foreground">
            NAV override{" "}
            <span className="font-normal text-muted-foreground">
              (optional — auto-fetched from mfapi.in if blank)
            </span>
          </span>
          <Input
            type="text"
            inputMode="decimal"
            value={form.nav_override}
            onChange={(e) => updateField("nav_override", e.target.value)}
            placeholder="e.g. 24.5234 — leave blank for auto-lookup"
            disabled={pending}
          />
        </label>

        {/* Description note — optional. Defaults to "Manual entry —
            direct-AMC purchase (non-Groww)" if left blank. */}
        <label className="flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="font-medium text-foreground">
            Note{" "}
            <span className="font-normal text-muted-foreground">
              (optional — defaults to &quot;Manual entry — direct-AMC purchase&quot;)
            </span>
          </span>
          <Input
            type="text"
            value={form.description_note}
            onChange={(e) => updateField("description_note", e.target.value)}
            placeholder="e.g. ICICI Prudential app SIP — instalment 6/361"
            disabled={pending}
          />
        </label>

        {/* Live preview of net amount + stamp duty. Reassures the user
            that the ₹0.50 discrepancy between what they entered and
            what shows up in the ledger is intentional. Only shown when
            the amount parses to a valid positive number. */}
        {preview && form.tx_type === "purchase" && (
          <div className="sm:col-span-2 flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px]">
            <Info
              size={12}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <div className="flex-1 leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                {fmtINR(grossParsed)}
              </span>{" "}
              gross − <span className="text-foreground">₹{preview.stampDuty.toFixed(2)}</span>{" "}
              stamp duty ={" "}
              <span className="font-medium text-foreground">
                {fmtINR(preview.netAmount)}
              </span>{" "}
              recorded as the NAV-applied amount. Matches CAS convention.
            </div>
          </div>
        )}

        <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 pt-1">
          <Button type="submit" disabled={pending} className="min-w-[9rem]">
            {pending ? (
              <>
                <Loader2 size={14} className="mr-2 animate-spin" />
                Recording…
              </>
            ) : (
              "Record transaction"
            )}
          </Button>

          {feedback && (
            <div
              className={cn(
                "flex items-start gap-1.5 text-[11px]",
                feedback.ok
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              )}
            >
              {feedback.ok ? (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              )}
              <div>
                <div className="font-medium">{feedback.message}</div>
                {feedback.ok && (
                  <div className="mt-0.5 text-muted-foreground">
                    {feedback.details}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </form>
    </Card>
  );
}

// ── Bulk order-history review table ─────────────────────────────────
//
// Only "successful" rows land here — in-progress, cancelled, failed,
// and unknown statuses are summarized in the paste-feedback message
// above the table and never rendered as rows (they'd be un-editable
// and un-submittable anyway, and in-progress orders naturally return
// as successful in a later paste with the same TxnID). See the
// bucketing logic in LogMfTxCard.handleParsePaste for the full
// rationale.

function BulkReviewTable({
  rows,
  pending,
  onToggle,
  onFundChange,
  onDateChange,
  onAmountChange,
  onSubmit,
}: {
  rows: BulkRow[];
  pending: boolean;
  onToggle: (key: string, checked: boolean) => void;
  onFundChange: (key: string, fundCode: string) => void;
  onDateChange: (key: string, txDate: string) => void;
  onAmountChange: (key: string, amountInput: string) => void;
  onSubmit: () => void;
}) {
  const checkedCount = rows.filter((r) => r.checked).length;
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-background/40">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border/60 text-[9px] uppercase text-muted-foreground">
              <th className="w-8 py-1.5 pl-2" />
              <th className="py-1.5 pr-2 text-left font-medium">Fund</th>
              <th className="py-1.5 pr-2 text-left font-medium" title="Day whose NAV was applied. Auto-resolved from mf_nav_history using the NAV value INDmoney reported. Placed date (Subtitle1) shown beneath when it differs — a post-3PM-cutoff order rolls to the next trading day.">
                NAV date
              </th>
              <th className="py-1.5 pr-2 text-left font-medium">Units @ NAV</th>
              <th className="py-1.5 pr-2 text-left font-medium">Amount (₹)</th>
              <th className="py-1.5 pr-2 text-left font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pl-2">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    disabled={pending}
                    onChange={(e) => onToggle(r.key, e.target.checked)}
                    className="h-3 w-3 rounded border-input"
                  />
                </td>
                <td className="py-1.5 pr-2">
                  <select
                    value={r.fundCode}
                    disabled={pending}
                    onChange={(e) => onFundChange(r.key, e.target.value)}
                    className="h-6 rounded border border-input bg-transparent px-1 text-[11px] text-foreground disabled:opacity-50"
                  >
                    <option value="">— select —</option>
                    {FUND_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.code}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 pr-2">
                  <input
                    type="date"
                    value={r.txDate}
                    max={todayIso}
                    disabled={pending}
                    onChange={(e) => onDateChange(r.key, e.target.value)}
                    className="h-6 rounded border border-input bg-transparent px-1 text-[11px] text-foreground disabled:opacity-50"
                  />
                  {r.placedDate && r.placedDate !== r.txDate && (
                    <div
                      className="mt-0.5 text-[9px] leading-tight text-muted-foreground"
                      title={`INDmoney Subtitle1 (order-placed date). NAV date auto-derived from mf_nav_history using the NAV value ${r.item.nav ?? "?"} — post-cutoff order rolled to ${r.txDate}.`}
                    >
                      Placed {r.placedDate}
                    </div>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {r.item.units != null && r.item.nav != null
                    ? `${r.item.units} @ ${r.item.nav}`
                    : "—"}
                </td>
                <td className="py-1.5 pr-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={r.amountInput}
                    disabled={pending}
                    onChange={(e) => onAmountChange(r.key, e.target.value)}
                    className="h-6 w-20 rounded border border-input bg-transparent px-1 text-[11px] text-foreground disabled:opacity-50"
                  />
                </td>
                <td className="py-1.5 pr-2">
                  {r.submitState === "pending" && (
                    <Loader2 size={11} className="animate-spin text-muted-foreground" />
                  )}
                  {r.submitState === "ok" && (
                    <span className="text-[hsl(var(--success))]">{r.submitMessage}</span>
                  )}
                  {r.submitState === "error" && (
                    <span className="text-[hsl(var(--danger))]">{r.submitMessage}</span>
                  )}
                  {r.submitState === "idle" && r.existingMatch === undefined && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Loader2 size={10} className="animate-spin" />
                      checking…
                    </span>
                  )}
                  {r.submitState === "idle" && r.existingMatch?.matchedBy === "source_ref" && (
                    <span
                      className="text-[hsl(var(--success))]"
                      title={`Deterministic match on INDmoney TxnID ${r.item.txn_id}: source=${r.existingMatch.source}, ${fmtINR(r.existingMatch.amount)}, ${r.existingMatch.units.toFixed(4)} units. Safe to skip.`}
                    >
                      Same order on file · {fmtINR(r.existingMatch.amount)}
                    </span>
                  )}
                  {r.submitState === "idle" && r.existingMatch?.matchedBy === "weak_key" && (
                    <span
                      className="text-[hsl(var(--warning))]"
                      title={`Same fund+date+type exists but this order's TxnID isn't tagged on the existing row (source=${r.existingMatch.source}, ${fmtINR(r.existingMatch.amount)}, ${r.existingMatch.units.toFixed(4)} units). Likely the same trade; verify before re-checking. Studio platform=test rows are ignored by this check.`}
                    >
                      Fund+date already used · {fmtINR(r.existingMatch.amount)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-2 py-2">
        <span className="text-[10px] text-muted-foreground">
          Amount is editable — INDmoney's abbreviated total and the units×NAV
          figure can both drift a few paise from the real net amount; confirm
          before logging.
        </span>
        <Button
          type="button"
          size="sm"
          onClick={onSubmit}
          disabled={pending || checkedCount === 0}
          className="inline-flex shrink-0 items-center gap-1.5"
        >
          {pending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ListChecks size={12} />
          )}
          Log {checkedCount} selected
        </Button>
      </div>
    </div>
  );
}
