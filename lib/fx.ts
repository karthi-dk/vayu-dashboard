/**
 * lib/fx.ts
 *
 * USD→INR exchange-rate helpers for the International asset class.
 *
 * Two rates, two jobs:
 *   • fetchUsdInrLive()    — today's spot, for marking USD holdings on
 *                            each refresh (option A: the INR value floats
 *                            with the live market rate, so it reflects the
 *                            honest "what I'd get back today" number).
 *   • fetchUsdInrHistory() — per-day closes, for reconstructing the INR
 *                            value curve (and the FX-vs-NAV return split)
 *                            behind the International period grid.
 *
 * Live rate comes from open.er-api.com (free, no key). Historical closes
 * reuse Yahoo's chart feed (the same source lib/indexLevels already
 * depends on) via the USDINR=X ticker.
 */

const ER_API_LATEST = "https://open.er-api.com/v6/latest/USD";

/**
 * Today's USD→INR spot. Throws on network / shape failure so the caller
 * can abort a mark rather than silently persisting a bogus value.
 */
export async function fetchUsdInrLive(): Promise<number> {
  const res = await fetch(ER_API_LATEST, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`USD→INR live HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; rates?: { INR?: number } };
  const inr = Number(json.rates?.INR);
  if (json.result !== "success" || !Number.isFinite(inr) || inr <= 0) {
    throw new Error(`USD→INR live: invalid rate ${json.rates?.INR}`);
  }
  return inr;
}

/**
 * Daily USD→INR closes between two ISO dates (inclusive), as a
 * Map<YYYY-MM-DD, rate>. Uses Yahoo's USDINR=X daily bars. Missing /
 * null bars (weekends, holidays) are simply absent from the map; the
 * caller forward-fills or falls back as appropriate. Returns an empty
 * map on failure rather than throwing — historical FX is a
 * best-effort enrichment for the curve, never a hard dependency.
 */
export async function fetchUsdInrHistory(
  fromDate: string,
  toDate: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const p1 = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${toDate}T23:59:59Z`) / 1000);
  if (!Number.isFinite(p1) || !Number.isFinite(p2)) return out;

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X` +
    `?period1=${p1}&period2=${p2}&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return out;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      const iso = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      out.set(iso, Number(c));
    }
  } catch {
    // best-effort — swallow and return whatever we have
  }
  return out;
}
