import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import { istDate, previousBusinessDay } from "@/lib/istDate";

/**
 * NPS daily NAV refresh — Kotak primary + npsnav.in fallback
 * ==========================================================
 *
 * DATA SOURCES (in priority order)
 * --------------------------------
 * 1. Kotak Mahindra Pension Fund's own API — kmamcapi.kotakmf.in
 *    Authoritative source. Returns all 23 Kotak pension schemes (POP, GS,
 *    DIRECT variants for E/C/G Tier I & II) in a single GET. We filter for
 *    the POP variant of E, C, and G Tier I — that's the variant the user
 *    is invested in (verified via Kotak CAS: schemes are labelled
 *    "KOTAK PENSION FUND SCHEME E/C/G - TIER I POP"). No auth, no session.
 *
 *    Historical note (Jul 17, 2026): we previously filtered for DIRECT here,
 *    which produced NAVs that were ~₹0.05 higher on E/C and ~₹0.02 lower on
 *    G — the DB accumulated ~₹200 of drift vs the true POP portfolio value.
 *    See migrations/2026-07-17-nps-pop-correction.sql for the data fix.
 *
 *    Radware-fingerprinted: fails if user-agent looks like a bot or the
 *    sec-ch-ua / sec-fetch-site headers are missing. Our headers mimic a
 *    real Chrome request to pass this check.
 *
 * 2. npsnav.in — a community scraper. Fallback path.
 *    Uses scheme codes SM005001 / SM005002 / SM005003 (ambiguous "TIER I"
 *    names — no POP/DIRECT suffix — but empirically the NAVs are closer to
 *    Kotak's POP variant than to DIRECT). npsnav.in doesn't expose a
 *    clean POP-explicit scheme code, so we tolerate the ambiguity and
 *    treat this path as best-effort. npsnav.in also tends to lag Kotak's
 *    official publish by 1 day — acceptable given this only fires when
 *    Kotak API itself is unreachable.
 *
 * BEHAVIOR
 * --------
 * Handler tries Kotak first. On any failure (network, Radware challenge
 * returning HTML, invalid JSON shape, missing scheme), it silently falls
 * back to npsnav.in and records nav_source='npsnav.in'. If BOTH fail, the
 * request errors out with the reason from each attempt.
 *
 * The primary/fallback selection is invisible to the UI — one button, one
 * outcome. The only visible signal is a small "from Kotak" / "from
 * npsnav.in (fallback)" tag on the Sync card, purely for transparency.
 *
 * WHY WE STORE PREV NAVS
 * ----------------------
 * A "1D delta" that's just (today.nps_value - yesterday.nps_value) from
 * nw_daily is unreliable — if a day is skipped (e.g., Sunday when the cron
 * doesn't run), the diff silently expands to a 2- or 3-day change. Storing
 * the previous NAV on nps_state itself lets us always compute a true
 * "per-NAV-cycle" delta as units × (nav - nav_prev), no matter when the
 * next refresh happens to fall.
 *
 * HANDLERS
 * --------
 * GET and POST both do the same thing so this endpoint works for:
 *   • Vercel Cron (hits with GET automatically at 06:00 IST daily)
 *   • Manual button on Sync page (fires POST via fetch)
 */

// ── Types ────────────────────────────────────────────────────────────────
type NavData = { nav: number; navDate: string | null };
type NavBundle = { E: NavData; C: NavData; G: NavData };
type NavSource = "kotak" | "npsnav.in";

// ── Kotak: primary source ────────────────────────────────────────────────

const KOTAK_URL =
  "https://kmamcapi.kotakmf.in/PENSIONFUND/api/Values/Get_PensionFund_Data/";

/**
 * Headers required to pass Kotak's Radware bot check. Empirically bisected:
 *
 *   sec-ch-ua        — client-hints browser identifier (required)
 *   sec-fetch-site   — fetch metadata (required)
 *   user-agent       — must NOT be Node's default "node" (required)
 *
 * The other headers are optional but included for defense-in-depth. If Kotak
 * tightens their detection, they're most likely to add fingerprints we can
 * satisfy by passing the full browser-shaped set below.
 */
const KOTAK_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-GB,en;q=0.6",
  "content-type": "application/json",
  origin: "https://www.kotakpensionfund.com",
  referer: "https://www.kotakpensionfund.com/",
  "sec-ch-ua":
    '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
};

type KotakScheme = {
  PORTFOLIO?: string;
  PORTFOLIO_NAME?: string;
  NAV_PER_UNIT?: string | number;
  ENTRY_DATE?: string;
};

/**
 * Locate the E/C/G POP variant in Kotak's flat scheme list.
 *
 * Same PORTFOLIO code (e.g. "PFE") appears 3 times — Direct, GS, POP.
 * Discrimination is via PORTFOLIO_NAME suffix:
 *   • ...SCHEME E TIER I POP      ← the one we want (user's variant)
 *   • ...SCHEME E TIER I DIRECT   ← for eNPS-direct subscribers
 *   • ...SCHEME E TIER I GS       ← Govt Sector employees only
 *
 * A naive find(p => p.PORTFOLIO === "PFE") would pick whichever appeared
 * first in the array (order isn't stable, so we can't rely on that).
 *
 * NAMING QUIRK — Kotak's data is inconsistent about the "TIER I" separator:
 *   • Scheme E:  "...SCHEME E TIER  I POP"   (double space, no hyphen)
 *   • Scheme C:  "...SCHEME C TIER - I POP"  (space-hyphen-space)
 *   • Scheme G:  "...SCHEME G TIER - I POP"  (space-hyphen-space)
 *
 * So the regex must accept whitespace OR hyphens between TIER and I.
 * Confirmed by fetching the live Kotak API and dumping all PFE/PFC/PFG rows
 * (see /tmp/pop-test/pop.mjs from Jul 17, 2026 investigation).
 *
 * The Tier II reject uses the same "any of whitespace/hyphens" character
 * class so it catches "TIER II", "TIER - II", "TIER  II" all uniformly.
 */
function findKotakPop(
  rows: KotakScheme[],
  letter: "E" | "C" | "G"
): NavData | null {
  const code = `PF${letter}`;
  const match = rows.find(
    (r) =>
      r.PORTFOLIO === code &&
      typeof r.PORTFOLIO_NAME === "string" &&
      /TIER[\s-]+I\s+POP/.test(r.PORTFOLIO_NAME) &&
      !/TIER[\s-]*I{2,}/.test(r.PORTFOLIO_NAME)
  );
  if (!match) return null;

  const nav = Number(match.NAV_PER_UNIT);
  if (!Number.isFinite(nav) || nav <= 0) return null;

  // Kotak ENTRY_DATE is "DD-MM-YYYY HH:MM:SS". Extract DD-MM-YYYY and
  // convert to ISO YYYY-MM-DD to match how we store nav_date.
  const dateMatch = String(match.ENTRY_DATE ?? "").match(
    /^(\d{2})-(\d{2})-(\d{4})/
  );
  const navDate = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
    : null;

  return { nav, navDate };
}

/**
 * Return type distinguishes success from various failure modes. When the
 * fallback engages, the handler surfaces the reason via server-side console
 * (for `next dev` and Vercel logs) and via `kotak_fallback_reason` in the
 * response JSON (so a user can inspect DevTools Network without needing
 * server access). Silent-then-fallback with no diagnostic makes it too easy
 * to sit on a permanently-broken primary path.
 */
type KotakResult =
  | { ok: true; bundle: NavBundle }
  | { ok: false; reason: string };

async function fetchAllFromKotak(): Promise<KotakResult> {
  try {
    const res = await fetch(KOTAK_URL, {
      headers: KOTAK_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    // Radware bot-challenge responds with HTTP 200 but text/html — the
    // captcha challenge page. Guard against parsing it as JSON.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) {
      // Include a short body preview so we can tell "Radware challenge" from
      // "Cloudflare block" from "Kotak returned an HTML error page".
      const preview = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
      return {
        ok: false,
        reason: `Non-JSON response (ct=${ct.slice(0, 40)}): ${preview}…`,
      };
    }

    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      return { ok: false, reason: "Response body is not an array" };
    }
    const rows = data as KotakScheme[];

    const E = findKotakPop(rows, "E");
    const C = findKotakPop(rows, "C");
    const G = findKotakPop(rows, "G");
    if (!E || !C || !G) {
      // Enumerate which schemes were missing to help diagnose Kotak
      // renaming/removing schemes in the future.
      const missing = [
        !E && "E",
        !C && "C",
        !G && "G",
      ].filter(Boolean).join(", ");
      return {
        ok: false,
        reason: `POP variant missing for scheme(s): ${missing}. Kotak returned ${rows.length} rows.`,
      };
    }

    return { ok: true, bundle: { E, C, G } };
  } catch (err) {
    // Timeout, DNS, SSL, JSON parse, abort, network — all bubble here.
    return {
      ok: false,
      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

// ── npsnav.in: fallback source ───────────────────────────────────────────

/**
 * Scheme codes for the POP variants of E/C/G Tier I on npsnav.in.
 *
 * npsnav.in doesn't expose a code whose name explicitly includes "POP" —
 * SM005001-003 return as "KOTAK PENSION FUND SCHEME E/C/G - TIER I" with
 * no variant suffix. Empirically their NAVs track Kotak's POP variant
 * (verified Jul 17, 2026: SM005001=67.8918 vs Kotak POP-Jul-16=67.9376,
 * whereas SM005016 DIRECT-codes return 67.9785). SM005001-003 are also
 * roughly 1 day behind Kotak's official publish — acceptable for a
 * fallback that only fires when Kotak API itself is unreachable.
 *
 * Historical note: we briefly used SM005016-018 (DIRECT-explicit) when
 * the code path was configured for DIRECT variants. That was reverted on
 * Jul 17, 2026 after CAS reconciliation showed the user is invested in
 * POP variants — see route.ts docblock and the migration.
 *
 * If npsnav.in ever adds explicit POP scheme codes, update this map and
 * re-enable the name sanity check in fetchSchemeFromNpsnav.
 */
const NPSNAV_SCHEMES = {
  E: "SM005001",
  C: "SM005002",
  G: "SM005003",
} as const;

const NPSNAV_BASE = "https://npsnav.in/api/detailed";

type NpsNavResponse = {
  NAV?: string | number;
  "Last Updated"?: string;
  "Scheme Name"?: string;
  [key: string]: unknown;
};

async function fetchSchemeFromNpsnav(schemeCode: string): Promise<NavData> {
  const url = `${NPSNAV_BASE}/${schemeCode}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "vayu-dashboard/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`npsnav.in ${schemeCode}: HTTP ${res.status}`);

  const data = (await res.json()) as NpsNavResponse;
  const nav = Number(data.NAV);
  if (!Number.isFinite(nav) || nav <= 0) {
    throw new Error(`npsnav.in ${schemeCode}: invalid NAV "${data.NAV}"`);
  }

  // Sanity check: the SM005001-003 codes for POP are ambiguously named
  // by npsnav.in ("KOTAK PENSION FUND SCHEME E - TIER I" — no POP or
  // DIRECT suffix), so we CANNOT assert a specific variant name here. We
  // only reject if the name clearly points to a DIFFERENT scheme (e.g.
  // Tier II or a wrong PFM). If npsnav.in ever re-aliases these codes
  // to explicit DIRECT, this check will let us catch the drift.
  const name = String(data["Scheme Name"] ?? "");
  if (name) {
    if (/TIER\s*II/i.test(name)) {
      throw new Error(
        `npsnav.in ${schemeCode}: scheme name "${name}" is Tier II — code may have been re-aliased`
      );
    }
    if (/DIRECT/i.test(name)) {
      throw new Error(
        `npsnav.in ${schemeCode}: scheme name "${name}" is DIRECT — expected POP or ambiguous "TIER I", code may have been re-aliased`
      );
    }
  }

  // "Last Updated" arrives as "DD-MM-YYYY" — normalize to ISO YYYY-MM-DD.
  const rawDate = String(data["Last Updated"] ?? "");
  const dm = rawDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const navDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null;

  return { nav, navDate };
}

async function fetchAllFromNpsnav(): Promise<NavBundle> {
  // Parallel to minimize latency (three independent HTTPS requests). Any
  // single failure aborts the whole fallback — we never want a partial
  // update where E is fresh but G is stale (would compute a nonsense 1D).
  const [E, C, G] = await Promise.all([
    fetchSchemeFromNpsnav(NPSNAV_SCHEMES.E),
    fetchSchemeFromNpsnav(NPSNAV_SCHEMES.C),
    fetchSchemeFromNpsnav(NPSNAV_SCHEMES.G),
  ]);
  return { E, C, G };
}

// ── Handler ──────────────────────────────────────────────────────────────

async function fetchFromAnySource(): Promise<{
  bundle: NavBundle;
  source: NavSource;
  kotakFallbackReason?: string;
}> {
  // Primary
  const kotak = await fetchAllFromKotak();
  if (kotak.ok) return { bundle: kotak.bundle, source: "kotak" };

  // Kotak failed. Log the reason server-side so it appears in `next dev`
  // terminal and Vercel function logs, and pass it through so the handler
  // can echo it in the response payload for client-side visibility.
  console.warn(
    `[refresh-nps-nav] Kotak primary failed, falling back to npsnav.in. Reason: ${kotak.reason}`
  );

  // Fallback — will throw on failure and bubble to the handler's catch
  const npsnav = await fetchAllFromNpsnav();
  return {
    bundle: npsnav,
    source: "npsnav.in",
    kotakFallbackReason: kotak.reason,
  };
}

async function handler() {
  try {
    const { bundle, source, kotakFallbackReason } = await fetchFromAnySource();
    const { E: eResp, C: cResp, G: gResp } = bundle;

    // Load current nps_state so we can compute deltas and rotate NAVs.
    const { data: current, error: readErr } = await sbServer
      .from("nps_state")
      .select(
        "scheme_e_nav, scheme_c_nav, scheme_g_nav, scheme_e_units, scheme_c_units, scheme_g_units, nav_date"
      )
      .eq("id", 1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) {
      return NextResponse.json(
        {
          ok: false,
          error: "nps_state row (id=1) not found. Seed it via Settings first.",
        },
        { status: 400 }
      );
    }

    // Pick a nav_date. All three schemes should report the same date; if
    // they disagree, take whichever is non-null. Fall back to the previous
    // business day (NOT today) if all null — today is the FETCH day, never
    // the valuation day for an evening-declared NAV.
    let navDate =
      eResp.navDate ?? cResp.navDate ?? gResp.navDate ?? previousBusinessDay(istDate());

    // Roll a today-stamped NAV back to the prior trading day. NPS declares
    // each day's NAV in the evening (~9pm IST); Kotak's morning ENTRY_DATE
    // stamps a freshly-fetched NAV with TODAY even though the value is the
    // previous trading day's (verified 2026-08-28: value dated 27-Aug by
    // Kotak/npsnav, but its 8:47am ENTRY_DATE said 28-Aug). Before the
    // evening window we trust the value, not the date, so nav_date matches
    // the true valuation day (like AMFI does for MF).
    const istHour =
      parseInt(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          hour12: false,
        }).format(new Date()),
        10
      ) % 24;
    if (navDate >= istDate() && istHour < 20) {
      navDate = previousBusinessDay(istDate());
    }

    // Value-unchanged guard: if the source returned identical NAV values
    // to what we already have (even if the DATE it claims is fresher),
    // treat as already_fresh. This defends against a bug class we hit
    // 2026-07-23 00:37 IST: Kotak's page briefly showed 22-Jul NAVs
    // during the pre-publication window for the following day (NPS NAVs
    // typically publish overnight T+1). Our regex-based date parser
    // failed to find a date match in the HTML, so lines above fell back
    // to istDate() = today = 23-Jul. Without this guard, the route
    // would rotate 22-Jul values into "23-Jul" — with nav_prev set to
    // the previous nav (also 22-Jul values), producing delta = 0 AND
    // pre-empting tomorrow's legitimate 23-Jul refresh (which would
    // then trip the "already have 23-Jul" idempotency check below).
    //
    // NPS NAVs are 5-digit precision; a 0.0001 tolerance covers any
    // conceivable rounding drift between calls to the same source
    // while still catching real intraday moves.
    const eSame = Math.abs(
      eResp.nav - Number(current.scheme_e_nav ?? 0)
    ) < 0.0001;
    const cSame = Math.abs(
      cResp.nav - Number(current.scheme_c_nav ?? 0)
    ) < 0.0001;
    const gSame = Math.abs(
      gResp.nav - Number(current.scheme_g_nav ?? 0)
    ) < 0.0001;
    if (eSame && cSame && gSame && current.nav_date) {
      await sbServer
        .from("nps_state")
        .update({ nav_updated_at: new Date().toISOString() })
        .eq("id", 1);
      return NextResponse.json({
        ok: true,
        already_fresh: true,
        source,
        kotak_fallback_reason: kotakFallbackReason,
        // Report the DB's date, not the (possibly-bogus) source-derived
        // date, so the UI's "as of ..." chip stays accurate.
        nav_date: current.nav_date,
        message: `NAVs unchanged from ${current.nav_date}. Source ${source} returned identical values — today's NPS NAV likely not yet published.`,
      });
    }

    // Idempotency guard: if the DB already reflects this NAV date, this is
    // a repeated click within the same NAV cycle (both sources only
    // publish once per trading day). Doing the full update would rotate
    // the CURRENT nav into nav_prev — destroying the legit 1D delta we
    // computed on the first click. Return an "already fresh" response and
    // preserve both nps_state and nw_daily.
    if (current.nav_date && current.nav_date === navDate) {
      // Bump nav_updated_at only ("we did check today") but DO NOT touch
      // nav_source. Overwriting nav_source here silently strips the
      // 'cas_reconciliation' marker from a CAS-anchored row on the very
      // next refresh attempt, hiding the paste's provenance from the
      // UI. The user's "click processed" signal comes from
      // nav_updated_at going to now(); we don't need nav_source for
      // that. Same reasoning applies to the monotonicity branch below.
      await sbServer
        .from("nps_state")
        .update({ nav_updated_at: new Date().toISOString() })
        .eq("id", 1);
      return NextResponse.json({
        ok: true,
        already_fresh: true,
        source,
        kotak_fallback_reason: kotakFallbackReason,
        nav_date: navDate,
        message: `NAVs already fresh (as of ${navDate}). Source: ${source}.`,
      });
    }

    // Monotonicity guard: refuse to overwrite fresher data with staler
    // data. This matters when Kotak publishes T+1 same-day but npsnav.in
    // lags to T+2 — if Kotak fails and we fall back, the returned date
    // could be OLDER than what's in the DB. Rotating older-than-current
    // NAVs into prev would produce a nonsense negative 1D delta and
    // pollute the historical record.
    //
    // The cron will retry tomorrow and try Kotak again; better to skip
    // one refresh cycle than to regress the timeline.
    if (current.nav_date && navDate < current.nav_date) {
      // Timestamp-only bump; leave nav_source alone. See idempotency
      // branch comment above for the CAS-provenance-preservation
      // rationale.
      await sbServer
        .from("nps_state")
        .update({ nav_updated_at: new Date().toISOString() })
        .eq("id", 1);
      return NextResponse.json({
        ok: true,
        skipped_stale: true,
        source,
        kotak_fallback_reason: kotakFallbackReason,
        nav_date: navDate,
        current_nav_date: current.nav_date,
        message: `Source ${source} returned ${navDate}, older than current ${current.nav_date}. Skipped to preserve fresher data.`,
      });
    }

    const eUnits = Number(current.scheme_e_units ?? 0);
    const cUnits = Number(current.scheme_c_units ?? 0);
    const gUnits = Number(current.scheme_g_units ?? 0);
    const ePrevNav = Number(current.scheme_e_nav ?? 0);
    const cPrevNav = Number(current.scheme_c_nav ?? 0);
    const gPrevNav = Number(current.scheme_g_nav ?? 0);

    // Compute per-scheme ₹ change first. If prev NAV is 0 (fresh install,
    // never refreshed before), treat delta as 0 for this scheme — the
    // first refresh baselines the values so the SECOND refresh can produce
    // a legit 1D.
    const eDelta = ePrevNav > 0 ? eUnits * (eResp.nav - ePrevNav) : 0;
    const cDelta = cPrevNav > 0 ? cUnits * (cResp.nav - cPrevNav) : 0;
    const gDelta = gPrevNav > 0 ? gUnits * (gResp.nav - gPrevNav) : 0;
    const nps1DInr = eDelta + cDelta + gDelta;

    // Denominator for % change = prior value of the whole NPS pot
    const prevValue = eUnits * ePrevNav + cUnits * cPrevNav + gUnits * gPrevNav;
    const nps1DPct = prevValue > 0 ? (nps1DInr / prevValue) * 100 : 0;

    // Atomic-ish update: PostgREST doesn't give us multi-row transactions
    // here, but this is a single-row update so consistency is preserved
    // by PostgreSQL's row-level MVCC guarantees.
    const { error: updateErr } = await sbServer
      .from("nps_state")
      .update({
        scheme_e_nav_prev: ePrevNav || null,
        scheme_c_nav_prev: cPrevNav || null,
        scheme_g_nav_prev: gPrevNav || null,
        scheme_e_nav: eResp.nav,
        scheme_c_nav: cResp.nav,
        scheme_g_nav: gResp.nav,
        nav_date: navDate,
        nav_updated_at: new Date().toISOString(),
        nav_source: source,
      })
      .eq("id", 1);
    if (updateErr) throw updateErr;

    // Refresh today's nw_daily row with the new NPS values plus the proper
    // 1D override. This closes the loop on the "delta_nps always 0" issue
    // — the Overview headline badge now reflects true NPS moves.
    await recomputeNwDaily({
      nps_1d_change_inr: Number(nps1DInr.toFixed(2)),
      nps_1d_change_pct: Number(nps1DPct.toFixed(4)),
    });

    // Persist today's NAVs into nps_nav_history so the daily reconstruction
    // series (see lib/queries.buildNpsDailyHistory) stays fresh without
    // needing a periodic backfill. The initial backfill hits
    // npsnav.in/api/historical to seed the whole history in one shot;
    // this daily write is the keep-alive that carries the series
    // forward from that point.
    //
    // Best-effort: any error here just logs and continues. Missing rows in
    // nps_nav_history degrade to "value curve looks flat between this NAV
    // date and the next backfill" — not fatal to the app, and easy to
    // recover from by re-running the backfill script. We don't want a
    // hiccup in the history table to break the daily NAV refresh itself.
    //
    // Source label distinguishes primary vs fallback in the history table
    // so we can later audit "how often did we lose Kotak and fall to
    // npsnav.in?" without cross-referencing external timestamps.
    const historySource = source === "kotak" ? "kotak" : "npsnav.in-daily";
    try {
      const { error: navHistErr } = await sbServer
        .from("nps_nav_history")
        .upsert(
          [
            {
              scheme_code: "SM005001",
              scheme: "E",
              nav_date: navDate,
              nav: eResp.nav,
              source: historySource,
            },
            {
              scheme_code: "SM005002",
              scheme: "C",
              nav_date: navDate,
              nav: cResp.nav,
              source: historySource,
            },
            {
              scheme_code: "SM005003",
              scheme: "G",
              nav_date: navDate,
              nav: gResp.nav,
              source: historySource,
            },
          ],
          { onConflict: "scheme_code,nav_date" }
        );
      if (navHistErr) {
        // 42P01/PGRST205 → nps_nav_history migration hasn't been applied
        // yet (e.g. staging that lags prod). Log but don't fail.
        const code = (navHistErr as { code?: string }).code;
        if (code === "42P01" || code === "PGRST205") {
          console.warn(
            "[refresh-nps-nav] nps_nav_history missing — apply migration " +
              "2026-07-19-nps-nav-history.sql to persist daily NAV series."
          );
        } else {
          console.warn(
            `[refresh-nps-nav] nps_nav_history upsert failed: ${navHistErr.message}`
          );
        }
      }
    } catch (err) {
      console.warn(
        `[refresh-nps-nav] nps_nav_history upsert threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    return NextResponse.json({
      ok: true,
      source,
      kotak_fallback_reason: kotakFallbackReason,
      // Signals for the client banner to choose the right verbiage:
      //   first_refresh: this run baselined prev NAVs; 1D delta is 0 by
      //     design because prev was null. Next call will produce a legit
      //     1D.
      //   already_fresh (returned earlier if hit): DB already had this
      //     nav_date; no update was performed.
      first_refresh: ePrevNav === 0 || cPrevNav === 0 || gPrevNav === 0,
      message: `NPS NAVs refreshed from ${source}`,
      nav_date: navDate,
      nps_1d_change_inr: Number(nps1DInr.toFixed(2)),
      nps_1d_change_pct: Number(nps1DPct.toFixed(4)),
      schemes: {
        E: {
          nav: eResp.nav,
          nav_prev: ePrevNav || null,
          delta_inr: Number(eDelta.toFixed(2)),
        },
        C: {
          nav: cResp.nav,
          nav_prev: cPrevNav || null,
          delta_inr: Number(cDelta.toFixed(2)),
        },
        G: {
          nav: gResp.nav,
          nav_prev: gPrevNav || null,
          delta_inr: Number(gDelta.toFixed(2)),
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 502 = both upstream sources failed. 500 = internal error (DB, etc).
    // Since Kotak failure silently falls back to npsnav.in, if we hit this
    // path at all, it means BOTH sources are down or the error is DB-side.
    const status = msg.includes("npsnav.in") ? 502 : 500;
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        hint:
          status === 502
            ? "Both Kotak API and npsnav.in are unreachable. Try again in a few minutes."
            : undefined,
      },
      { status }
    );
  }
}

export const GET = handler;
export const POST = handler;
