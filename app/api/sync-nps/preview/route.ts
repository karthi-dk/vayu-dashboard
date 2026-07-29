/**
 * POST /api/sync-nps/preview
 *
 * Accepts a raw CAMS NPS CAS CSV (either as text/plain body or a
 * {"csv": "..."} JSON envelope) and returns the structured diff the UI
 * renders as a "here's what will change" summary.
 *
 * This endpoint DOES NOT WRITE ANYTHING. The paired apply endpoint
 * (see ../apply/route.ts) re-parses the same CSV and re-diffs against
 * fresh DB state before executing — the client never sends the
 * intermediate diff structure back, only the raw CSV plus the user's
 * per-row decisions.
 */

import { NextResponse } from "next/server";
import { CamsParseError } from "@/lib/nps/camsParser";
import { computeCasDiff, extractCsv } from "@/lib/nps/casServer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const csv = await extractCsv(req);
  if (!csv || csv.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "Empty body. Paste the CAS CSV as text/plain or JSON {csv: '...'}." },
      { status: 400 }
    );
  }

  try {
    const { diff } = await computeCasDiff(csv);
    return NextResponse.json({ ok: true, diff });
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
    // Log so the server console + Vercel logs surface the trace even
    // though the response body only carries the message string.
    console.error("[sync-nps/preview] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
