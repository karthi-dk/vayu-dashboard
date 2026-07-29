import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { parseSotHtml, type NpsSotTx } from "@/lib/npscra/parseSotHtml";
import { AUTO_TX_SOURCE } from "@/lib/npscra/deriveAutoTx";

/**
 * NPS CRA "Statement of Transactions" HTML ingest endpoint.
 *
 * Body: raw HTML (text/html or text/plain). Parser is the same one
 * used by scripts/ingest-nps-cra-sot.ts, so browser-paste and CLI
 * ingest can't diverge in what they consider valid.
 *
 * Effects:
 *   1. Delete any source='auto_credits' rows in nps_transactions
 *      whose tx_date falls within the CRA statement's period. Those
 *      rows were estimates written by logRetirementCredit as a stop-
 *      gap; the CRA paste is authoritative and supersedes them.
 *   2. Upsert the parsed transactions with source='protean_cra_sot'
 *      on conflict (source, tx_hash) → ignore. Re-pasting the same
 *      file is a no-op.
 *
 * Idempotency of the wipe: DELETE is a set operation and only
 * touches rows we ourselves wrote (source filter). Re-running is
 * safe (nothing left to delete on second call).
 *
 * Failure modes:
 *   • parseSotHtml throws only on unrecognised statement shape (no
 *     period or zero scheme blocks) → 400.
 *   • Wipe DELETE fails → 500 with the DB error, and we do NOT
 *     proceed to the upsert. Leaving auto rows in place is safer
 *     than double-counting (auto + CRA both present).
 *   • Upsert fails → 500 with the DB error. Wipe has already run,
 *     so the chart will be missing contributions in the paste's
 *     date range until you retry.
 */
export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — one FY's SOT is ~50 KB

type IngestResponse = {
  ok: true;
  message: string;
  fy: string;
  period: { from: string; to: string };
  parsed: {
    total_rows: number;
    contribution_count: number;
    contribution_amount: number;
    billing_count: number;
    billing_amount: number;
  };
  written: {
    inserted: number;
    skipped_existing: number;
    auto_wiped: number;
  };
  warnings: string[];
};

const SOURCE = "protean_cra_sot";

export async function POST(req: Request) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BYTES) {
      return NextResponse.json(
        { error: `Payload > ${MAX_BYTES} bytes` },
        { status: 413 }
      );
    }
    const html = await req.text();
    if (!html || !html.trim()) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }

    // ── Parse ─────────────────────────────────────────────────────
    let parsed;
    try {
      parsed = parseSotHtml(html);
    } catch (e) {
      return NextResponse.json(
        { error: `Parse failed: ${(e as Error).message}` },
        { status: 400 }
      );
    }

    const writable: NpsSotTx[] = parsed.transactions.filter(
      (t) => t.tx_type !== "other"
    );

    // ── Wipe auto_credits rows in the CRA period ───────────────────
    // Filter by tx_date within the parsed period. This deliberately
    // matches on date (not tx_hash) — the auto and CRA rows carry
    // different hashes by design, and we want the CRA rows to
    // become the sole authoritative record for that date range.
    const dateRange = computeDateRange(writable, parsed.period);
    let autoWiped = 0;
    if (dateRange) {
      const wipeRes = await sbServer
        .from("nps_transactions")
        .delete()
        .eq("source", AUTO_TX_SOURCE)
        .gte("tx_date", dateRange.from)
        .lte("tx_date", dateRange.to)
        .select("id");
      if (wipeRes.error) {
        return NextResponse.json(
          {
            error: `Wipe of auto_credits rows failed: ${wipeRes.error.message}`,
          },
          { status: 500 }
        );
      }
      autoWiped = wipeRes.data?.length ?? 0;
    }

    // ── Pre-flight: count existing CRA hashes so the response can
    //    honestly split "inserted" vs "skipped_existing" (PostgREST's
    //    ignore-duplicates hides that split otherwise). ────────────
    const hashes = writable.map((t) => t.tx_hash);
    let skippedExisting = 0;
    if (hashes.length > 0) {
      const existingRes = await sbServer
        .from("nps_transactions")
        .select("tx_hash")
        .eq("source", SOURCE)
        .in("tx_hash", hashes);
      if (existingRes.error) {
        return NextResponse.json(
          {
            error: `Pre-flight failed: ${existingRes.error.message}`,
          },
          { status: 500 }
        );
      }
      skippedExisting = existingRes.data?.length ?? 0;
    }

    // ── Upsert CRA rows ────────────────────────────────────────────
    const payload = writable.map((t) => ({
      source: SOURCE,
      tx_hash: t.tx_hash,
      tx_date: t.tx_date,
      fy: t.fy,
      tier: t.tier,
      scheme: t.scheme,
      tx_type: t.tx_type,
      amount: t.amount,
      nav: t.nav,
      units: t.units,
      description_raw: t.description_raw,
      uploaded_by: t.uploaded_by,
      contribution_side: t.contribution_side,
      raw: {
        scheme_name_raw: t.scheme_name_raw,
        source_row_idx: t.source_row_idx,
      },
    }));

    if (payload.length > 0) {
      const upsertRes = await sbServer
        .from("nps_transactions")
        .upsert(payload, {
          onConflict: "source,tx_hash",
          ignoreDuplicates: true,
        });
      if (upsertRes.error) {
        return NextResponse.json(
          { error: `Upsert failed: ${upsertRes.error.message}` },
          { status: 500 }
        );
      }
    }

    const inserted = writable.length - skippedExisting;
    const response: IngestResponse = {
      ok: true,
      message: `Ingested FY ${parsed.fy}: ${inserted} new, ${skippedExisting} unchanged, ${autoWiped} auto-derived rows replaced`,
      fy: parsed.fy,
      period: parsed.period,
      parsed: parsed.totals,
      written: {
        inserted,
        skipped_existing: skippedExisting,
        auto_wiped: autoWiped,
      },
      warnings: parsed.warnings,
    };
    return NextResponse.json(response);
  } catch (e) {
    return NextResponse.json(
      { error: `Unexpected: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}

/**
 * The wipe range should cover every date the CRA statement claims
 * authority over. Use the parsed period as the outer envelope, but
 * clip to actual writable transactions in case the period spans
 * dates before the user's first contribution (nothing to wipe there).
 */
function computeDateRange(
  writable: NpsSotTx[],
  period: { from: string; to: string }
): { from: string; to: string } | null {
  if (writable.length === 0) return null;
  const dates = writable.map((t) => t.tx_date).sort();
  const from = dates[0] < period.from ? dates[0] : period.from;
  const to = dates[dates.length - 1] > period.to ? dates[dates.length - 1] : period.to;
  return { from, to };
}
