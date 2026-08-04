"use client";

import { useEffect, useState } from "react";

// Auto-retry budget for the transient post-wake clock-skew error
// (PGRST303 "JWT issued at future"). Module-level so the cap survives
// Next.js remounting this boundary on each reset(); self-resets after a
// quiet gap so a later, unrelated error gets a fresh budget.
let clockSkewRetries = { count: 0, at: 0 };
const MAX_CLOCK_SKEW_RETRIES = 3;
const CLOCK_SKEW_QUIET_RESET_MS = 20_000;

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [repairing, setRepairing] = useState(false);
  // PGRST303 "JWT issued at future" is a transient dev-time clock-skew
  // blip that self-heals once the OS finishes its post-wake NTP re-sync.
  // In dev the raw message reaches the client, so we auto-retry after a
  // short real-time wait instead of forcing a manual Retry. (Prod never
  // sees it — Vercel's clock is steady — and redacts the message anyway.)
  const isTransientClockSkew =
    /PGRST303/.test(error.message) ||
    /jwt issued at future/i.test(error.message);
  const willAutoRetry =
    isTransientClockSkew &&
    (Date.now() - clockSkewRetries.at > CLOCK_SKEW_QUIET_RESET_MS ||
      clockSkewRetries.count < MAX_CLOCK_SKEW_RETRIES);
  const [recovering, setRecovering] = useState(willAutoRetry);

  useEffect(() => {
    if (!willAutoRetry) return;
    setRecovering(true);
    const t = setTimeout(() => {
      // Commit the budget only when the retry actually fires, so React
      // strict-mode's schedule→cleanup→reschedule doesn't double-count.
      const now = Date.now();
      const fresh = now - clockSkewRetries.at > CLOCK_SKEW_QUIET_RESET_MS;
      clockSkewRetries = {
        count: (fresh ? 0 : clockSkewRetries.count) + 1,
        at: now,
      };
      reset();
    }, 1500);
    return () => clearTimeout(t);
  }, [willAutoRetry, reset]);
  const isTls =
    error.message.includes("SELF_SIGNED_CERT") ||
    error.message.includes("fetch failed");

  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true);

  async function refreshInstalledApp() {
    if (typeof window === "undefined") return;
    setRepairing(true);
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // Best effort only.
    } finally {
      window.location.replace(`/?pwa-refresh=${Date.now()}`);
    }
  }

  if (recovering) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">
          Recovering from a temporary sync hiccup…
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Could not load dashboard data
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {isTls ? (
          <>
            Supabase fetch failed — often caused by a corporate SSL proxy on
            local dev. Run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              npm run dev
            </code>{" "}
            (it sets <code className="font-mono text-xs">NODE_TLS_REJECT_UNAUTHORIZED=0</code>{" "}
            for local only). On Vercel this does not apply.
          </>
        ) : (
          error.message
        )}
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground/80">Digest: {error.digest}</p>
      ) : null}
      <button
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Retry
      </button>
      {isStandalone ? (
        <button
          onClick={() => {
            void refreshInstalledApp();
          }}
          disabled={repairing}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
        >
          {repairing ? "Refreshing app shell..." : "Refresh installed app"}
        </button>
      ) : null}
    </div>
  );
}
