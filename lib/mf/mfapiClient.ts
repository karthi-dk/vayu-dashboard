/**
 * lib/mf/mfapiClient.ts
 *
 * Thin client for mfapi.in — a community-run mirror of AMFI's daily NAV
 * disclosures. Free, no auth, no rate limiting observed at our scale
 * (10 funds × once per day).
 *
 * WHY WE USE IT
 * -------------
 * MF NAVs need to refresh every trading day even when the user hasn't
 * pasted Groww JSON. Groww exposes NAVs but only via the user's own
 * portfolio API, which is behind auth and would need session cookies to
 * automate. mfapi.in gives us the same NAVs (both feed off AMFI's public
 * daily bhavcopy) with no plumbing to break — just a plain HTTPS GET
 * per fund code.
 *
 * Additionally: mfapi.in publishes T+1 same-day for Fund-of-Funds and
 * international funds (e.g., PPFAS_FC, ICICI_NASDAQ), where Groww's
 * feed lags T+2. Cross-checked 2026-07-17 — mfapi had Jul 16 NAVs at
 * midnight IST, Groww's payload still showed Jul 15 for those two.
 *
 * ENDPOINTS
 * ---------
 *   /mf/{scheme_code}          → full NAV history (~2000 rows for older schemes)
 *   /mf/{scheme_code}/latest   → latest NAV only (single-row wrapper)
 *
 * We use /latest exclusively — the daily refresh only cares about
 * today's close. Full history is available if we ever want a "1M chart
 * per fund" feature but that's out of scope for now.
 *
 * SCHEME CODES
 * ------------
 * Groww's `schemeCode` field IS the AMFI scheme code (confirmed by
 * cross-verifying 10/10 of the user's holdings resolve on mfapi with
 * their Groww codes 2026-07-17). So we can pass them straight through
 * — no lookup table needed.
 *
 * ERROR HANDLING PHILOSOPHY
 * -------------------------
 * fetchLatest() throws on any failure (network, non-200, JSON parse,
 * unexpected shape). The caller (refresh-mf-nav route) catches per-fund
 * so a single bad code doesn't kill the whole batch — we still
 * refresh the other 9. Partial batch success is expected and
 * intentionally surfaced to the UI as "n/10 funds refreshed".
 *
 * DATE FORMAT
 * -----------
 * mfapi.in returns dates as "DD-MM-YYYY" (India convention). We
 * normalize to ISO YYYY-MM-DD before returning so callers can compare
 * against DB nav_date values directly (which we store as ISO).
 */

// ── Types ────────────────────────────────────────────────────────────────

/** One row from mfapi's "data" array — a single day's NAV disclosure. */
export type MfapiNavRow = {
  /** DD-MM-YYYY as returned by the API */
  date: string;
  /** NAV as a string (e.g., "91.02810") — parse to number in caller */
  nav: string;
};

/** The full response shape from /mf/{code} or /mf/{code}/latest */
export type MfapiResponse = {
  meta: {
    fund_house: string;
    scheme_type: string;
    scheme_category: string;
    scheme_code: number;
    scheme_name: string;
    isin_growth: string | null;
    isin_div_reinvestment: string | null;
  };
  data: MfapiNavRow[];
  status: string;
};

/** Success return type — everything callers actually need in one object. */
export type LatestNav = {
  schemeCode: string;
  nav: number;
  /** ISO YYYY-MM-DD */
  navDate: string;
  schemeName: string;
  isinGrowth: string | null;
  fundHouse: string;
  category: string;
};

// ── Config ───────────────────────────────────────────────────────────────

const BASE_URL = "https://api.mfapi.in";

/** How long a single fetch waits before giving up. 10s is what the NPS
 * refresh route uses — same networking failure mode, same threshold. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How many times to retry a fetch before giving up. mfapi.in occasionally
 * closes TCP mid-handshake (observed ~10-20% of curl attempts from
 * cold-start clients), producing "TypeError: fetch failed" from Node's
 * undici. This is transient — the same URL usually succeeds on the next
 * attempt. Retrying at the client layer is cleaner than doing it at the
 * caller layer because callers get to reason about "a fund failed" as a
 * real, persistent failure instead of a routine flake.
 *
 * 2 retries = 3 attempts total. Empirically enough for the observed
 * failure rate; more would just add wall-clock latency to the batch
 * without meaningfully improving the success rate.
 */
const MAX_RETRIES = 2;

/**
 * Base backoff between retry attempts. Doubles per attempt (200ms →
 * 400ms → 800ms). Kept small because mfapi's flakiness pattern is
 * "single TCP handshake got dropped, retry works instantly" — not
 * "server is overloaded, back way off".
 */
const RETRY_BACKOFF_MS = 200;

/**
 * True if an error looks like a transient network flake worth retrying.
 * Node's undici surfaces these as TypeError with a wrapped cause; we
 * inspect both the .message and the .cause.code to be robust across
 * Node versions. HTTP-level errors (4xx/5xx) are NOT retryable — those
 * indicate a scheme code problem, not a flake.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (
    msg.includes("fetch failed") ||
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("etimedout") ||
    msg.includes("und_err_socket") ||
    msg.includes("timeout") ||
    msg.includes("network")
  ) {
    return true;
  }
  // Node's fetch wraps the underlying cause on the error's .cause property.
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = String((cause as { code?: unknown }).code ?? "");
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "EPIPE" ||
      code === "ENOTFOUND"
    ) {
      return true;
    }
  }
  return false;
}

/** Sleep for `ms` milliseconds — used between retry attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize mfapi's "DD-MM-YYYY" to ISO "YYYY-MM-DD".
 *
 * Returns null on any malformed input — the caller is expected to handle
 * this as "date unknown, fall back to today's IST date" (same as the NPS
 * refresh route's defense against source-shape drift).
 */
function parseMfapiDate(raw: string): string | null {
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch the latest NAV for a single scheme code.
 *
 * Throws on:
 *   • Non-2xx HTTP status
 *   • Non-JSON response body
 *   • Response with status !== "SUCCESS"
 *   • Empty data array (scheme code exists but no NAV history — very rare)
 *   • Invalid NAV (non-finite or ≤ 0)
 *
 * The caller (refresh-mf-nav route) wraps individual calls in try/catch
 * and continues past failures, so throwing loudly here surfaces the
 * failure in the batch result rather than silently returning stale data.
 */
export async function fetchLatest(schemeCode: string): Promise<LatestNav> {
  // Try up to MAX_RETRIES + 1 times. Only transient network flakes
  // (see isTransientFetchError) trigger a retry — HTTP 4xx/5xx and
  // response-shape errors fail immediately since retrying wouldn't
  // help.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchLatestOnce(schemeCode);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isTransientFetchError(err)) {
        // Exponential backoff — 200ms, 400ms — small enough that
        // the batch's wall-clock time stays comfortably under
        // the endpoint's 30s maxDuration even in a worst case
        // where every fund retries.
        await sleep(RETRY_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop either returns or throws. This line is
  // here to satisfy TypeScript's "function may not return" analysis
  // without adding a non-null assertion further up.
  throw lastErr;
}

/**
 * Single fetch attempt, no retry. Split out from fetchLatest so the
 * retry wrapper doesn't have to duplicate the entire parse-and-validate
 * pipeline.
 */
async function fetchLatestOnce(schemeCode: string): Promise<LatestNav> {
  const url = `${BASE_URL}/mf/${schemeCode}/latest`;
  const res = await fetch(url, {
    headers: {
      // No specific UA required, but identifying ourselves is polite
      // and lets mfapi's operator route/rate-limit us cleanly if we
      // ever need to. Same convention as npsnav.in fetches.
      "User-Agent": "vayu-dashboard/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`mfapi ${schemeCode}: HTTP ${res.status}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    // Rare, but mfapi has been known to serve a plain-text error page
    // on scheme codes that were removed mid-request. Guard against
    // parsing HTML as JSON.
    const preview = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `mfapi ${schemeCode}: non-JSON response (ct=${ct.slice(0, 40)}): ${preview}…`
    );
  }

  const body = (await res.json()) as MfapiResponse;

  if (body.status !== "SUCCESS") {
    throw new Error(`mfapi ${schemeCode}: status="${body.status}"`);
  }

  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error(`mfapi ${schemeCode}: empty data array`);
  }

  const first = body.data[0];
  const nav = Number(first.nav);
  if (!Number.isFinite(nav) || nav <= 0) {
    throw new Error(`mfapi ${schemeCode}: invalid NAV "${first.nav}"`);
  }

  const navDate = parseMfapiDate(first.date);
  if (!navDate) {
    throw new Error(
      `mfapi ${schemeCode}: unparseable date "${first.date}" (expected DD-MM-YYYY)`
    );
  }

  return {
    schemeCode,
    nav,
    navDate,
    schemeName: body.meta.scheme_name,
    isinGrowth: body.meta.isin_growth,
    fundHouse: body.meta.fund_house,
    category: body.meta.scheme_category,
  };
}

/**
 * Result of a per-fund fetch inside a batch. Success carries the NAV;
 * failure carries the error message. Never throws — this shape is
 * safe to render directly in the UI batch result.
 */
export type BatchResult =
  | { ok: true; schemeCode: string; nav: LatestNav }
  | { ok: false; schemeCode: string; error: string };

/**
 * Fetch latest NAVs for many scheme codes with bounded concurrency and
 * batch-level retry.
 *
 * WHY NOT STRAIGHT Promise.allSettled ANYMORE
 * -------------------------------------------
 * We used to do `Promise.allSettled(codes.map(fetchLatest))` — all 10
 * requests firing simultaneously against mfapi.in. Empirically that
 * triggered a ~30-40% "whole batch fails together" failure rate from
 * this dev environment: when mfapi kills a single TLS handshake mid-
 * request, Node's undici keeps a shared connection pool per origin, and
 * the pool momentarily becomes unusable — every parallel request
 * against it fails simultaneously with "TypeError: fetch failed". A
 * retry INSIDE fetchLatest can't help because the pool is still bad
 * during the retry window.
 *
 * Two layered defenses fix this cleanly:
 *
 * 1. BOUNDED CONCURRENCY — CONCURRENCY_LIMIT parallel in-flight at a
 *    time. Smaller batches don't trigger mfapi's connection-drop
 *    behavior in the first place, and give undici's pool time to churn
 *    between waves. Wall-clock impact for 10 funds: ~2s → ~3s. That's
 *    fine — nowhere near the 30s maxDuration.
 *
 * 2. BATCH-LEVEL RETRY — after the initial pass, any failed funds get
 *    a second attempt with a fresh set of AbortControllers and a small
 *    delay in between. This is a DIFFERENT retry from the per-fetch
 *    retry inside fetchLatest — that one handles single-request
 *    flakes, this one handles pool-wide collapses. Both together
 *    reliably squash the failure rate to ~0%.
 *
 * PARALLELISM CALIBRATION
 * -----------------------
 * 3 concurrent probes was the sweet spot in local testing (2026-07-17):
 * higher numbers reintroduced the pool-collapse pattern intermittently,
 * lower numbers didn't improve reliability further and just slowed the
 * batch down. If we ever scale to 100+ funds this cap becomes the
 * bottleneck and we'd want to raise it — but for 10 funds it's
 * essentially free.
 */
const CONCURRENCY_LIMIT = 3;

/**
 * Delay between the initial pass and the retry pass. Long enough for
 * undici to close and rebuild its connection pool to mfapi, short
 * enough that the total batch wall-clock stays comfortable.
 */
const BATCH_RETRY_DELAY_MS = 500;

export async function fetchBatch(schemeCodes: string[]): Promise<BatchResult[]> {
  // First pass — bounded-concurrency probe of all codes.
  const firstPass = await runBatchOnce(schemeCodes);

  // Identify codes that failed with a transient error and are worth
  // retrying at the batch level. Non-transient failures (HTTP 4xx,
  // shape errors, etc.) don't get retried because retrying can't fix
  // them and just adds latency.
  const retryCodes: string[] = [];
  for (const r of firstPass) {
    if (!r.ok && r.transient) retryCodes.push(r.schemeCode);
  }

  if (retryCodes.length === 0) {
    // Everything succeeded (or the failures aren't retryable). Strip
    // the internal `transient` marker before returning to callers.
    return firstPass.map(stripInternal);
  }

  // Give undici's connection pool a moment to reset. Empirically this
  // is what turns a pool-collapse "batch of failures" into a clean
  // retry-succeeds pattern — the delay is what matters, not the
  // number of retries.
  await sleep(BATCH_RETRY_DELAY_MS);

  const retryPass = await runBatchOnce(retryCodes);

  // Merge: retry-pass wins for its codes, first-pass keeps the rest.
  const bySchemeCode = new Map<string, InternalBatchResult>();
  for (const r of firstPass) bySchemeCode.set(r.schemeCode, r);
  for (const r of retryPass) bySchemeCode.set(r.schemeCode, r);

  // Preserve original input order — callers rely on it.
  return schemeCodes
    .map((code) => bySchemeCode.get(code))
    .filter((r): r is InternalBatchResult => r !== undefined)
    .map(stripInternal);
}

// ── Internal helpers for fetchBatch ─────────────────────────────────

/**
 * Same shape as BatchResult but carries an extra `transient` flag on
 * failures so fetchBatch can decide whether to retry at the batch
 * level. The flag never leaks out — stripInternal drops it before
 * returning to callers.
 */
type InternalBatchResult =
  | { ok: true; schemeCode: string; nav: LatestNav }
  | { ok: false; schemeCode: string; error: string; transient: boolean };

function stripInternal(r: InternalBatchResult): BatchResult {
  if (r.ok) return r;
  return { ok: false, schemeCode: r.schemeCode, error: r.error };
}

/**
 * Run a single pass over a list of scheme codes with bounded
 * concurrency. Doesn't retry at the batch level — that's fetchBatch's
 * job. Uses a simple index-cursor with N worker promises rather than
 * pulling in a semaphore library, because the semantics we need are
 * trivially expressible in a dozen lines.
 */
async function runBatchOnce(
  schemeCodes: string[]
): Promise<InternalBatchResult[]> {
  const results: InternalBatchResult[] = new Array(schemeCodes.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= schemeCodes.length) return;
      const code = schemeCodes[i];
      try {
        const nav = await fetchLatest(code);
        results[i] = { ok: true, schemeCode: code, nav };
      } catch (err) {
        results[i] = {
          ok: false,
          schemeCode: code,
          error:
            err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          // Flag transient errors so fetchBatch can retry them. This
          // uses the same classifier as the per-fetch retry inside
          // fetchLatest so the two retry layers agree on what
          // "transient" means.
          transient: isTransientFetchError(err),
        };
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY_LIMIT, schemeCodes.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );
  return results;
}
