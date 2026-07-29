/**
 * POST /api/sync-fund-holdings/[isin]
 *
 * Resync ONE fund's holdings, live, end to end, in a single hit:
 *   1. Fetch that fund's current holdings directly from Dhan's public
 *      SectorAllocation API (no CSV, no local Python step involved).
 *   2. Classify each holding against `master_security_classification`
 *      (already a Supabase table) to resolve ISIN + sector/industry,
 *      same matching logic as scripts/build_fund_holdings_map.py.
 *   3. DELETE that fund's existing rows from fund_holdings_detail AND
 *      fund_non_security_holdings, then INSERT the fresh set into both.
 *
 * Path param `isin` is the FUND's own scheme ISIN (e.g. INF879O01027 for
 * PPFAS_FC) — the same identifier Dhan itself uses to look up a fund,
 * sourced from FUND_ISIN in scripts/fetch_dhan_funds.py.
 *
 * WHY DELETE-THEN-INSERT (not upsert)
 * ------------------------------------
 * A plain upsert can only add/update holdings present in the fresh Dhan
 * response — it has no way to notice a holding the fund fully sold out of
 * since the last sync. Scoping the delete to this one fund_code and
 * immediately re-inserting its complete fresh snapshot guarantees the DB
 * always matches Dhan's current disclosure exactly, with no stale leftovers.
 *
 * WHY NO CSV / NO PYTHON STEP
 * ------------------------------
 * Earlier versions of this sync round-tripped through a locally-built CSV
 * (scripts/build_fund_holdings_map.py) that had to be pasted into the
 * dashboard. Since `master_security_classification` now lives in Supabase
 * itself, this route can do the classification lookup live against the DB
 * instead of against a local CSV — so the whole fetch -> classify -> write
 * pipeline runs in one request, triggered by hitting this endpoint.
 *
 * ATOMICITY
 * -----------
 * The actual delete+insert runs as ONE call to the `replace_fund_holdings`
 * Postgres function (see dashboard/schema.sql §11) via a single sb.rpc().
 * supabase-js's REST client would NOT give atomicity across separate
 * .from().delete()/.insert() calls (each is its own independent PostgREST
 * transaction) — that was the original design here and was corrected
 * 2026-07-13 specifically because a failed insert after a committed
 * delete meant permanently losing the fund's previous rows. Routing both
 * deletes and both inserts through one plpgsql function means any failure
 * anywhere inside it rolls back the whole thing — the previous rows
 * always survive a failed sync.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbServer as sb } from "@/lib/supabase";
import { ISIN_TO_FUND } from "@/lib/fundIsin";

const DHAN_ENDPOINT = "https://mf-openweb-search.dhan.co/SectorAllocation";
// Static app-level key, not a user session token — verified reusable across
// funds 2026-07-12 (see scripts/fetch_dhan_funds.py). Could be rotated by
// Dhan without notice; if fetches start failing with a non-200/HTML body,
// re-capture a fresh curl from a live dhan.co mutual-fund page and update.
// Reads from DHAN_TOKEN_ID env var first so a rotation only needs a Vercel
// env var update + redeploy, not a code change — falls back to the known-
// good value if the env var isn't set (e.g. local dev without .env.local).
const DHAN_TOKEN_ID = process.env.DHAN_TOKEN_ID || "9c5688945773312281d7";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// ISIN_TO_FUND imported from @/lib/fundIsin (kept in sync with scripts/fetch_dhan_funds.py)

const FUND_NAMES: Record<string, string> = {
  PPFAS_FC: "Parag Parikh Flexi Cap Fund",
  PPFAS_CH: "Parag Parikh Conservative Hybrid Fund",
  HDFC_FC: "HDFC Flexi Cap Fund",
  HDFC_SC: "HDFC Small Cap Fund",
  HDFC_STD: "HDFC Short Term Debt Fund",
  UTI_N50: "UTI Nifty 50 Index Fund",
  UTI_NN50: "UTI Nifty Next 50 Index Fund",
  NIPPON_MID: "Nippon India Mid Cap Fund",
  ICICI_NASDAQ: "ICICI Prudential Nasdaq 100 Index Fund",
  EDEL_MID: "Edelweiss Mid Cap Fund",
};

const HOLDING_TYPES_IN_SCOPE = new Set(["E", "ER", "B", "BD", "BT", "BY", "CD", "CP", "DS"]);

const NON_SECURITY_CATEGORY: Record<string, string> = {
  C: "Cash & Equivalents",
  CA: "Cash & Equivalents",
  CQ: "Cash & Equivalents",
  CR: "Cash & Equivalents",
  DG: "Derivative/Hedge",
  DH: "Derivative/Hedge",
  EL: "Derivative/Hedge",
  FO: "Fund-of-Funds",
  EX: "Regulatory Reserve",
};

// Confirmed-unlisted holdings that must never resolve to a real ISIN —
// see 05-decisions-log.md. Matched by (fund_code, company_name prefix).
const EXCLUDE_ROWS: [string, string][] = [["NIPPON_MID", "Globsyn Technologies"]];

// Exact company_name (as Dhan reports it, verbatim) -> master ISIN, for
// names that don't survive suffix-stripping normalization. Kept in sync
// with NAME_ALIASES in scripts/build_fund_holdings_map.py.
const NAME_ALIASES: Record<string, string> = {
  "Alphabet Inc Class A": "US02079K1079",
  "Alphabet Inc Class C": "US02079K3059",
  "Malco Energy Ltd.": "INE704J01044",
  "Talwandi Sabo Power Ltd.": "INE694L01019",
  "ARM Holdings PLC ADR": "US0420682058",
  "ASML Holding NV ADR": "USN070592100",
  "Marriott International Inc Class A": "US5719032022",
  "PDD Holdings Inc ADR": "US7223041028",
  "SanDisk Corp Ordinary Shares": "US80004C2008",
  "Shopify Inc Registered Shs -A- Subord Vtg": "CA82509L1076",
  "The Kraft Heinz Co": "US5007541064",
  "Thomson Reuters Corp": "CA8849038812",
};

const SUFFIX_PATTERNS: RegExp[] = [
  /\*+$/,
  /\s*-\s*Class [A-Z]$/i,
  /\s+Class [A-Z]$/i,
  /\s+Ordinary Shares.*$/i,
  /\s+Registered Shs.*$/i,
  /\s+ADR$/i,
  /\s+Common Stock$/i,
];

const LEGAL_SUFFIXES = /[,.]|\b(inc|corp|co|ltd|plc|nv|the)\b/gi;

function normalizeName(name: string): string {
  let n = name.trim();
  for (const pat of SUFFIX_PATTERNS) n = n.replace(pat, "");
  return n.trim().toLowerCase();
}

function looseNormalize(name: string): string {
  const n = normalizeName(name).replace(LEGAL_SUFFIXES, " ");
  return n.replace(/\s+/g, " ").trim();
}

// ---- Dhan fetch ----

interface DhanRawHolding {
  pmd_name: string;
  pmd_isin?: string;
  pmd_country?: string;
  pmd_weighting?: string;
  pmd_holdingtype?: string;
  pmd_sector?: string;
  pmd_ticker?: string;
  pmd_portfolio_date?: string;
}

async function fetchDhanHoldings(schemeIsin: string): Promise<{ holdings: DhanRawHolding[]; portfolioDate: string | null }> {
  const res = await fetch(DHAN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "*/*",
      Origin: "https://dhan.co",
      Referer: "https://dhan.co/",
      "User-Agent": BROWSER_UA,
    },
    body: JSON.stringify({
      entity_id: "DhanWeb",
      source: "W",
      token_id: DHAN_TOKEN_ID,
      data: { scheme_isin: schemeIsin },
    }),
  });
  if (!res.ok) throw new Error(`Dhan HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "success") {
    throw new Error(`Dhan returned status=${body.status} message=${body.message}`);
  }
  const holdings: DhanRawHolding[] = body.data ?? [];
  const portfolioDate = holdings.find((h) => h.pmd_portfolio_date)?.pmd_portfolio_date ?? null;
  return { holdings, portfolioDate };
}

// ---- master_security_classification lookups (live from DB) ----

interface MasterRow {
  isin: string;
  company_name: string;
  security_type: string;
  // NB: these are `raw_sector`/`raw_industry` in the DB, not `sector`/
  // `industry` — master_security_classification was deliberately renamed
  // on migration to avoid colliding with the taxonomy_sector columns (see
  // dashboard/schema.sql's column-rename comment block). Selecting the
  // wrong names here would 400 on every request — caught 2026-07-13 by
  // cross-checking this query against schema.sql before ever running it
  // against a real DB.
  raw_sector: string | null;
  raw_industry: string | null;
}

async function loadMaster(): Promise<{
  byIsin: Map<string, MasterRow>;
  byName: Map<string, string[]>;
  byLooseName: Map<string, string[]>;
}> {
  // PostgREST caps every query at ~1000 rows by default. master_security_classification
  // has 1630 rows as of 2026-07-14, so a plain .select() silently drops ~600 rows
  // (last alphabetically — includes most debt bond ISINs). Paginate explicitly.
  // Discovered when HDFC_STD resync flagged every real bond ISIN as "not found in master"
  // even though a direct Supabase query confirmed the ISIN was present.
  const PAGE = 1000;
  const all: MasterRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from("master_security_classification")
      .select("isin, company_name, security_type, raw_sector, raw_industry")
      .in("security_type", ["Equity", "REIT", "Debt"])
      .order("isin", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as MasterRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }

  const byIsin = new Map<string, MasterRow>();
  const byName = new Map<string, string[]>();
  const byLooseName = new Map<string, string[]>();

  for (const row of all) {
    byIsin.set(row.isin, row);
    const nameKey = row.company_name.trim().toLowerCase();
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), row.isin]);
    const looseKey = looseNormalize(row.company_name);
    byLooseName.set(looseKey, [...(byLooseName.get(looseKey) ?? []), row.isin]);
  }
  return { byIsin, byName, byLooseName };
}

type ResolveResult = { isin: string; note: string } | { isin: null; note: string };

function resolveIsin(
  holding: DhanRawHolding,
  fundCode: string,
  byIsin: Map<string, MasterRow>,
  byName: Map<string, string[]>,
  byLooseName: Map<string, string[]>
): ResolveResult {
  const rawIsin = (holding.pmd_isin ?? "").trim();
  if (rawIsin && rawIsin !== "NA") {
    if (!byIsin.has(rawIsin)) {
      return { isin: null, note: `Dhan ISIN ${rawIsin} not found in master (unexpected — investigate)` };
    }
    return { isin: rawIsin, note: "dhan-isin" };
  }

  const name = holding.pmd_name.trim();
  for (const [fc, prefix] of EXCLUDE_ROWS) {
    if (fundCode === fc && name.startsWith(prefix)) {
      return { isin: null, note: "excluded (confirmed unlisted)" };
    }
  }

  if (name in NAME_ALIASES) {
    return { isin: NAME_ALIASES[name], note: "name-alias-override" };
  }

  const exact = name.trim().toLowerCase();
  const exactMatches = byName.get(exact);
  if (exactMatches && exactMatches.length === 1) {
    return { isin: exactMatches[0], note: "name-exact-match" };
  }

  const norm = normalizeName(name);
  const normMatches = byName.get(norm);
  if (normMatches && normMatches.length === 1) {
    return { isin: normMatches[0], note: "name-suffix-stripped-match" };
  }

  const loose = looseNormalize(name);
  const looseMatches = byLooseName.get(loose);
  if (looseMatches && looseMatches.length === 1) {
    return { isin: looseMatches[0], note: "name-loose-match" };
  }

  return { isin: null, note: "UNRESOLVED — no ISIN, no name match" };
}

/**
 * Every resolveIsin() path is *supposed* to only ever return an isin that's
 * a key in byIsin — but NAME_ALIASES is a hardcoded map with no automatic
 * check that its ISINs still exist in master_security_classification (the
 * other 3 name-matching paths derive their candidates FROM byIsin, so they
 * can't drift; NAME_ALIASES can, if master ever changes without this map
 * being updated). Re-verifying here turns a silent `undefined` crash (or,
 * further downstream, a foreign-key violation that fails the entire insert
 * AFTER the old rows are already deleted) into a clean "unresolved" entry
 * that the rest of the sync proceeds past safely.
 */
function safeResolveIsin(
  holding: DhanRawHolding,
  fundCode: string,
  byIsin: Map<string, MasterRow>,
  byName: Map<string, string[]>,
  byLooseName: Map<string, string[]>
): ResolveResult {
  const resolved = resolveIsin(holding, fundCode, byIsin, byName, byLooseName);
  if (resolved.isin !== null && !byIsin.has(resolved.isin)) {
    return { isin: null, note: `${resolved.note} -> resolved ISIN ${resolved.isin} not in master (stale NAME_ALIASES entry?)` };
  }
  return resolved;
}

/** Dhan's weighting field is normally a clean numeric string, but this
 * guards against a malformed value ever reaching the DB as NaN — which
 * `JSON.stringify` silently turns into `null`, violating the NOT NULL
 * constraint on weighting_pct and failing the entire batch insert. */
function safeWeight(raw: string | undefined): { value: number; wasInvalid: boolean } {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return { value: 0, wasInvalid: true };
  return { value: Number(n.toFixed(5)), wasInvalid: false };
}

// ---- route handler ----

export const dynamic = "force-dynamic";
export const maxDuration = 30; // safety margin above Vercel's default — Dhan fetch + 2 selects + 2 deletes + up to 2 inserts, normally a couple seconds

export async function POST(_req: NextRequest, { params }: { params: Promise<{ isin: string }> }) {
  // NB: Next.js 15 changed dynamic-route `params` to a Promise. `next build`
  // (which runs on every Vercel deploy) rejects the old { isin: string }
  // synchronous shape at type-check time — passes plain `tsc --noEmit`, fails
  // Next.js's own route validator. Caught 2026-07-13 by running a real
  // `next build` against a scratch Next 15.5 install, before Vercel would
  // have caught it. See https://nextjs.org/docs/app/api-reference/file-conventions/route
  const { isin: schemeIsin } = await params;
  const fundCode = ISIN_TO_FUND[schemeIsin];
  if (!fundCode) {
    return NextResponse.json(
      { error: `Unknown fund scheme ISIN: ${schemeIsin}. Known: ${Object.keys(ISIN_TO_FUND).join(", ")}` },
      { status: 404 }
    );
  }

  // ---- Phase 1: fetch + classify entirely in memory. Nothing below this
  // point touches the DB, so any failure here (Dhan down, bad token, DB
  // read error) leaves the existing rows completely untouched. ----
  let holdings: DhanRawHolding[], portfolioDate: string | null;
  try {
    ({ holdings, portfolioDate } = await fetchDhanHoldings(schemeIsin));
  } catch (e) {
    return NextResponse.json(
      { error: `Dhan fetch failed — no data was touched. ${e instanceof Error ? e.message : e}` },
      { status: 502 }
    );
  }

  let byIsin: Map<string, MasterRow>, byName: Map<string, string[]>, byLooseName: Map<string, string[]>;
  try {
    ({ byIsin, byName, byLooseName } = await loadMaster());
  } catch (e) {
    return NextResponse.json(
      { error: `Loading master_security_classification failed — no data was touched. ${e instanceof Error ? e.message : e}` },
      { status: 500 }
    );
  }

  const extractedAt = new Date().toISOString();
  const fhdRows: Record<string, unknown>[] = [];
  const fnshRows: Record<string, unknown>[] = [];
  const unresolved: {
    company_name: string;
    dhan_isin: string | null;
    weighting_pct: number;
    note: string;
  }[] = [];
  const dataWarnings: string[] = [];
  const unknownHoldingTypes: {
    company_name: string;
    holding_type: string;
    weighting_pct: number;
  }[] = [];

  // Wrapped in try/catch: this loop touches nothing in the DB yet (still
  // Phase 1), but it does dereference fields on Dhan's raw JSON response
  // (an undocumented, reverse-engineered API) without runtime validation
  // — the DhanRawHolding interface only checks types at compile time. If
  // Dhan ever changes its response shape, this fails safely here with an
  // explicit "no data was touched" message instead of an unhandled 500.
  try {
    for (const h of holdings) {
      if (typeof h.pmd_name !== "string" || !h.pmd_name.trim()) {
        dataWarnings.push(`Skipped a holding with no usable pmd_name: ${JSON.stringify(h)}`);
        continue;
      }

      const htype = h.pmd_holdingtype ?? "";
      const { value: weight, wasInvalid } = safeWeight(h.pmd_weighting);
      if (wasInvalid) dataWarnings.push(`${h.pmd_name}: unparseable weighting_pct "${h.pmd_weighting}" — treated as 0`);

      if (htype in NON_SECURITY_CATEGORY) {
        fnshRows.push({
          fund_code: fundCode,
          fund_name: FUND_NAMES[fundCode] ?? fundCode,
          company_name: h.pmd_name,
          holding_type: htype,
          category: NON_SECURITY_CATEGORY[htype],
          weighting_pct: weight,
          isin: h.pmd_isin && h.pmd_isin !== "NA" ? h.pmd_isin : null,
          portfolio_date: portfolioDate,
          extracted_at: extractedAt,
        });
        continue;
      }

      if (!HOLDING_TYPES_IN_SCOPE.has(htype)) {
        // Neither a known security type nor a known non-security category —
        // previously silently dropped with zero trace. Now surfaced so a
        // new Dhan holding_type code doesn't quietly shrink weight coverage.
        unknownHoldingTypes.push({
          company_name: h.pmd_name,
          holding_type: htype,
          weighting_pct: weight,
        });
        continue;
      }

      const resolved = safeResolveIsin(h, fundCode, byIsin, byName, byLooseName);
      if (resolved.isin === null) {
        if (!resolved.note.startsWith("excluded")) {
          unresolved.push({
            company_name: h.pmd_name,
            dhan_isin:
              h.pmd_isin && h.pmd_isin !== "NA" ? h.pmd_isin : null,
            weighting_pct: weight,
            note: resolved.note,
          });
        }
        continue;
      }

      // Guaranteed present — safeResolveIsin() already verified byIsin.has(resolved.isin).
      const masterRow = byIsin.get(resolved.isin)!;
      fhdRows.push({
        fund_code: fundCode,
        fund_name: FUND_NAMES[fundCode] ?? fundCode,
        isin: resolved.isin,
        company_name: masterRow.company_name,
        security_type: masterRow.security_type,
        weighting_pct: weight,
        sector: masterRow.raw_sector,
        industry: masterRow.raw_industry,
        ticker: h.pmd_ticker && h.pmd_ticker !== "NA" ? h.pmd_ticker : null,
        country: h.pmd_country && h.pmd_country !== "NA" ? h.pmd_country : null,
        portfolio_date: portfolioDate,
        extracted_at: extractedAt,
        isin_resolution: resolved.note,
      });
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: `Classifying Dhan's holdings failed — no data was touched. Likely means Dhan changed its response shape. ${e instanceof Error ? e.message : e}`,
      },
      { status: 500 }
    );
  }

  // ---- Phase 2: destructive write, done as ONE atomic call. ----
  // Every row above is already validated (isin guaranteed present in
  // master, weighting_pct guaranteed a finite number), so by construction
  // this should never fail on data/logic grounds — only on genuine infra
  // issues. Critically, this is a single sb.rpc() call — one HTTP request
  // to PostgREST, wrapped in exactly one DB transaction on the Postgres
  // side (see replace_fund_holdings() in schema.sql). If ANYTHING inside
  // it fails, Postgres rolls back both deletes AND both inserts together
  // — the previous rows are left completely untouched. This is real
  // atomicity: unlike doing 4 separate .delete()/.insert() calls (each
  // its own independent transaction), there is no window where this
  // fund's data can end up empty because one later step failed.
  const { error: rpcError } = await sb.rpc("replace_fund_holdings", {
    p_fund_code: fundCode,
    p_fhd_rows: fhdRows,
    p_fnsh_rows: fnshRows,
  });
  if (rpcError) {
    return NextResponse.json(
      {
        error: `Sync failed and was fully rolled back — ${fundCode}'s existing rows in fund_holdings_detail and fund_non_security_holdings are UNCHANGED (this is the whole point of using an atomic RPC instead of separate delete/insert calls). Underlying error: ${rpcError.message}`,
      },
      { status: 500 }
    );
  }

  const weightCoverage = fhdRows.reduce((sum, r) => sum + (r.weighting_pct as number), 0);
  const nonSecWeightCoverage = fnshRows.reduce((sum, r) => sum + (r.weighting_pct as number), 0);

  // Persist sync diagnostics so the UI can surface "N unresolved" on the
  // Sync page card and list details in the modal — WITHOUT triggering a
  // fresh Dhan fetch on every page load. Deliberately non-fatal: if this
  // upsert fails (e.g. table doesn't exist yet in a new environment), we
  // still return success for the actual holdings sync above. Diagnostics
  // are secondary to the primary write.
  const diagRes = await sb.from("fund_sync_diagnostics").upsert(
    {
      fund_code: fundCode,
      synced_at: extractedAt,
      weight_coverage_pct: Number(weightCoverage.toFixed(2)),
      non_security_weight_pct: Number(nonSecWeightCoverage.toFixed(2)),
      unresolved,
      unknown_holding_types: unknownHoldingTypes,
      data_warnings: dataWarnings,
    },
    { onConflict: "fund_code" }
  );
  const diagWarning =
    diagRes.error != null
      ? `Sync succeeded but couldn't persist diagnostics: ${diagRes.error.message}. Run migrations/2026-07-14-fund-sync-diagnostics.sql if this is a fresh environment.`
      : null;

  return NextResponse.json({
    fund_code: fundCode,
    scheme_isin: schemeIsin,
    portfolio_date: portfolioDate,
    fund_holdings_detail_rows: fhdRows.length,
    fund_non_security_holdings_rows: fnshRows.length,
    weight_coverage_pct: Number(weightCoverage.toFixed(2)),
    non_security_weight_pct: Number(nonSecWeightCoverage.toFixed(2)),
    unresolved,
    unknown_holding_types: unknownHoldingTypes,
    data_warnings: dataWarnings,
    diagnostics_persisted: diagRes.error == null,
    diagnostics_warning: diagWarning,
  });
}
