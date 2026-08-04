/**
 * Retry helper for transient Supabase clock-skew errors.
 *
 * PostgREST rejects a request with PGRST303 "JWT issued at future" when the
 * auth token's `iat` looks ahead of the DB's clock. In practice this fires
 * briefly right after a laptop wakes from sleep: the OS clock drifts ahead
 * of real time for a second or two before NTP re-syncs, so the FIRST server
 * request after wake fails the handshake while later ones succeed. That's
 * why a browser reload of the landing page after a few idle hours can throw
 * "Could not load dashboard data", yet clicking any nav route (a moment
 * later, clock re-synced) loads fine.
 *
 * Retrying the read a couple of times with a short backoff turns that
 * transient blip into a non-event instead of a hard route-level error.
 * Mirrors the inline retry already used by lib/systemHealth.ts's table
 * probes — extracted here so page loaders can share it.
 */

type MaybePostgrestError = { code?: unknown; message?: unknown };

export function isTransientJwtFutureError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as MaybePostgrestError;
  return (
    code === "PGRST303" &&
    typeof message === "string" &&
    /jwt issued at future/i.test(message)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying ONLY on the transient JWT-future clock-skew error —
 * any other error is thrown immediately (no point masking a real failure).
 * Backoff defaults to 250ms → 750ms → 1.5s → 3s (~5.5s of real-time
 * headroom for a post-wake NTP re-sync). This cost is ONLY ever incurred
 * on the skew path — every other error throws on the first attempt — and
 * the happy path returns immediately.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  backoffMs: number[] = [250, 750, 1500, 3000]
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientJwtFutureError(err) || attempt >= backoffMs.length) {
        throw err;
      }
      await wait(backoffMs[attempt]);
    }
  }
}
