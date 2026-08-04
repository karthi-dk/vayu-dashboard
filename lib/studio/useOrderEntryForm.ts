"use client";

import { useEffect, useState, useTransition } from "react";
import { logMfTransaction } from "@/app/actions";
import { lookupNavForFundOnDate } from "@/app/studio/actions";
// Import from the client-safe fund catalog (no node:crypto pulled in).
// logMfTx.ts re-exports the same functions but its own transitive
// imports would poison the browser bundle.
import { knownFundCodes } from "@/lib/mf/fundCatalog";
import { PLATFORMS } from "@/lib/mf/platform";
import { unlockAudio } from "@/lib/studio/sounds";

/**
 * useOrderEntryForm — shared business logic for every Studio
 * `*OrderEntryLanding` component (Classic, Clay, Glass, Neumorphic,
 * Skeuomorphic).
 *
 * All five theme components previously carried a verbatim copy of
 * this state machine (NAV auto-fetch, submit handler, the
 * `?forceError=` dev hook, TEST_MODE tagging) so a fix to one could
 * silently drift from the others. Extracted here so there is exactly
 * one implementation; theme components only own the visual layer.
 */

const IS_TEST_MODE = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";

/**
 * Amount ladder — the six years of ₹1,000/day step-ups from the
 * 10K→100Cr briefing (Sept 2026: ₹10K, Sept 2027: ₹11K, …). Shown
 * top-to-bottom in the dropdown so this year's value is right at
 * the top where it belongs.
 */
export const ORDER_ENTRY_AMOUNT_LADDER = [
  10000, 11000, 12000, 13000, 14000, 15000,
];

/** Yesterday in India Standard Time as a YYYY-MM-DD string.
 *  IST-anchored so a user opening the app at 1 AM local UTC still
 *  sees "yesterday" as the previous IST trading day. */
function yesterdayISO_IST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  // Build a UTC-midnight anchor from the IST date parts, subtract a
  // day, then serialise. UTC-anchored math keeps this DST-safe (IST
  // has no DST; the arithmetic is deterministic).
  const today = new Date(`${y}-${m}-${d}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

export type NavLookupState = "idle" | "loading" | "found" | "notfound";

export function useOrderEntryForm({
  onSubmitted,
}: {
  /** Called after logMfTransaction returns ok:true. Parent flips to
   *  the reveal state and triggers the animation sequence. */
  onSubmitted: () => void;
}) {
  const funds = knownFundCodes();
  // Filter 'test' out of the user-visible platform dropdown — it's
  // an internal sentinel applied automatically when TEST_MODE is on,
  // never a user-selectable option.
  const platforms = PLATFORMS.filter((p) => p.code !== "test");

  // ── Form state ─────────────────────────────────────────────
  const [fund, setFund] = useState<string>("");
  const [amount, setAmount] = useState<number>(ORDER_ENTRY_AMOUNT_LADDER[0]);
  const [amountMode, setAmountMode] = useState<"ladder" | "custom">("ladder");
  const [navDate, setNavDate] = useState<string>(yesterdayISO_IST());
  const [navValue, setNavValue] = useState<number | null>(null);
  const [platform, setPlatform] = useState<string>("indmoney");
  const [customPlatform, setCustomPlatform] = useState<string>("");
  const [platformMode, setPlatformMode] = useState<"list" | "custom">("list");

  // ── Async / lookup state ───────────────────────────────────
  const [navLookupState, setNavLookupState] =
    useState<NavLookupState>("idle");
  const [navLookupError, setNavLookupError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Bumped on every real submit tap — theme components key a
  // decorative <SubmitBurst> off this so each click restarts the
  // flourish regardless of how fast the API resolves.
  const [submitPulseKey, setSubmitPulseKey] = useState(0);

  // Auto-populate NAV whenever fund + navDate are both set.
  // Cancellation guard prevents a stale response from a slow
  // network overwriting a fresher one from a quick re-pick.
  useEffect(() => {
    if (!fund || !navDate) return;
    let cancelled = false;
    setNavLookupState("loading");
    setNavLookupError(null);
    lookupNavForFundOnDate(fund, navDate).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setNavValue(res.nav);
        setNavLookupState("found");
      } else {
        setNavLookupState("notfound");
        setNavLookupError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fund, navDate]);

  const units =
    amount > 0 && navValue && navValue > 0 ? amount / navValue : null;
  const canSubmit =
    fund !== "" &&
    amount > 0 &&
    navValue != null &&
    navValue > 0 &&
    (platformMode === "list" || customPlatform.trim() !== "");

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitPulseKey((k) => k + 1);

    // Dev / demo hook — visit /studio?forceError=1 to short-circuit
    // this handler and render the red alert block without touching
    // the DB. Useful for video takes and QA sweeps of the failure
    // path. Pass a custom message via ?forceError=<encoded-string>
    // if you want to demo a specific server error copy. The
    // ~700ms delay matches a typical server round-trip so the
    // "Logging…" pending state is briefly visible before the alert
    // flips in. This block is a no-op in normal traffic.
    if (typeof window !== "undefined") {
      const forced = new URLSearchParams(window.location.search).get(
        "forceError",
      );
      if (forced) {
        const message =
          forced === "1"
            ? 'Upsert failed: duplicate key value violates unique constraint "mf_transactions_tx_hash_key"'
            : forced;
        startTransition(async () => {
          await new Promise((r) => setTimeout(r, 700));
          setSubmitError(message);
        });
        return;
      }
    }

    // AUDIO — the "click" sound itself is played by the global
    // StudioClickSound listener (mounted at the /studio route root),
    // which taps for every button/dropdown gesture. We only need to
    // ensure the AudioContext is warmed up here so that the
    // subsequent scheduled sounds (cracker at Lottie start, swoosh
    // at chart-draw, ding at pill-land, rollup at cascade start)
    // fire without an initial-gesture delay. unlockAudio is
    // idempotent; safe to call every submit.
    void unlockAudio();
    // VISUAL PREFETCH — kick off the CelebrationOverlay chunk fetch
    // in the background so the ~127KB Lottie JSON + lottie-react
    // player are warm by the time the server action resolves and
    // page.tsx switches to the 'celebrating' stage. The dynamic
    // import here mirrors the one wrapped by next/dynamic in
    // page.tsx — webpack de-duplicates them, so this is essentially
    // free apart from starting the fetch ~500ms-1s earlier than it
    // would otherwise. The .catch swallows the promise so a rare
    // network hiccup doesn't leak an unhandled rejection.
    void import("@/components/studio/CelebrationOverlay").catch(() => {});
    // Test-mode override — user's platform pick is preserved in local
    // state (visible in the dropdown) but the ACTUAL write is tagged
    // 'test' so downstream headline math ignores it.
    const submittedPlatform = IS_TEST_MODE
      ? "test"
      : platformMode === "custom"
        ? customPlatform.trim()
        : platform;
    startTransition(async () => {
      const res = await logMfTransaction({
        fund_code: fund,
        tx_date: navDate,
        tx_type: "purchase",
        amount_inr: amount,
        nav_override: navValue!,
        platform: submittedPlatform,
        nav_source_label: IS_TEST_MODE ? "studio_test" : "studio_manual",
      });
      if (!res.ok) {
        setSubmitError(res.error);
        return;
      }
      onSubmitted();
    });
  };

  return {
    funds,
    platforms,
    fund,
    setFund,
    amount,
    setAmount,
    amountMode,
    setAmountMode,
    navDate,
    setNavDate,
    navValue,
    setNavValue,
    platform,
    setPlatform,
    customPlatform,
    setCustomPlatform,
    platformMode,
    setPlatformMode,
    navLookupState,
    navLookupError,
    submitError,
    isPending,
    units,
    canSubmit,
    handleSubmit,
    submitPulseKey,
  };
}
