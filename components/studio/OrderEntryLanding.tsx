"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Volume2, X } from "lucide-react";
import { logMfTransaction } from "@/app/actions";
import { lookupNavForFundOnDate } from "@/app/studio/actions";
// Import from the client-safe fund catalog (no node:crypto pulled in).
// logMfTx.ts re-exports the same functions but its own transitive
// imports would poison the browser bundle.
import { knownFundCodes } from "@/lib/mf/fundCatalog";
import { PLATFORMS } from "@/lib/mf/platform";
import { unlockAudio } from "@/lib/studio/sounds";

/**
 * OrderEntryLanding — the landing card of /studio.
 *
 * Video narrative role (from the 10K→100Cr briefing):
 * ---------------------------------------------------
 * "Yesterday I placed an INDmoney order for ₹10,000 into <fund>.
 *  Today I'm resolving that allotment on VAYU." → user picks fund,
 *  keeps the default yesterday date, sees NAV auto-fill from
 *  mf_nav_history or mfapi, sees units compute live, taps Submit →
 *  M3+ animation sequence takes over.
 *
 * Design choices worth calling out
 * ---------------------------------
 * • NATIVE <select> ELEMENTS — Android/iOS render these as OS-level
 *   pickers with large touch targets, spring physics, and haptic
 *   ticks for free. A hand-rolled combobox would look "webby" on
 *   camera; native pickers feel like a native app. The ladder /
 *   list vs custom toggle preserves free-text override for the
 *   rare "not-in-vocabulary" case (annual bonus lumpsum ₹5L, or
 *   platform 'Groww Web Beta').
 *
 * • AUTO-POPULATE ON (fund, navDate) CHANGE — the moment either
 *   field has a value AND both are non-empty, we hit
 *   lookupNavForFundOnDate. Cancelled by a re-render so a rapid
 *   date-picker sweep doesn't fire 30 network calls; effect-cleanup
 *   sets a `cancelled` flag before the next call.
 *
 * • NAV VALUE IS EDITABLE even after auto-fill — you might want to
 *   log a purchase with a NAV that's not yet in mf_nav_history
 *   (INDmoney sometimes publishes ahead of mfapi). The subtle
 *   "auto-fetched" / "not found — enter manually" chip next to the
 *   label tells you which state you're in.
 *
 * • UNITS ARE READ-ONLY, computed live — following Groww/INDmoney
 *   convention. Users don't want to type units; they get them from
 *   the AMC. If you need to override units (rare — usually only when
 *   testing rounding edge cases), edit the mf_transactions row in
 *   SQL after the fact.
 *
 * • TEST MODE — read once at module load. When true, platform is
 *   FORCED to 'test' on submit regardless of what's in the dropdown.
 *   The dropdown still shows the real platforms so you can rehearse
 *   the muscle memory of picking one, but the effective write is
 *   sentinel. The TestModeBanner above the form makes this obvious.
 */

const IS_TEST_MODE = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";

/**
 * Amount ladder — the six years of ₹1,000/day step-ups from the
 * 10K→100Cr briefing (Sept 2026: ₹10K, Sept 2027: ₹11K, …). Shown
 * top-to-bottom in the dropdown so this year's value is right at
 * the top where it belongs.
 */
const AMOUNT_LADDER = [10000, 11000, 12000, 13000, 14000, 15000];

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

type NavLookupState = "idle" | "loading" | "found" | "notfound";

export function OrderEntryLanding({
  onSubmitted,
  onSkipped,
}: {
  /** Called after logMfTransaction returns ok:true. Parent flips to
   *  the reveal state and (M3+) triggers the animation sequence. */
  onSubmitted: () => void;
  /** Called when the user taps Skip — no DB write, straight to
   *  reveal, no animation. Parent handles the state flip. */
  onSkipped: () => void;
}) {
  const funds = knownFundCodes();
  // Filter 'test' out of the user-visible platform dropdown — it's
  // an internal sentinel applied automatically when TEST_MODE is on,
  // never a user-selectable option.
  const platforms = PLATFORMS.filter((p) => p.code !== "test");

  // ── Form state ─────────────────────────────────────────────
  const [fund, setFund] = useState<string>("");
  const [amount, setAmount] = useState<number>(AMOUNT_LADDER[0]);
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

  const units = amount > 0 && navValue && navValue > 0
    ? amount / navValue
    : null;
  const canSubmit =
    fund !== "" &&
    amount > 0 &&
    navValue != null &&
    navValue > 0 &&
    (platformMode === "list" || customPlatform.trim() !== "");

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitError(null);

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

  return (
    // `relative` anchors the absolutely-positioned close (X) button
    // to the card's top-right corner. On mobile (which is the primary
    // /studio target) the card fills the width, so top-4/right-4
    // reads as viewport corner. On desktop the card is capped at
    // max-w-md and centered — X sits at the card's right edge, which
    // still reads as "dismiss this surface" for a modal-like flow.
    <div className="relative mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6">
      {/* Skip / close — was a full-width secondary button next to
          Submit; user tuning 2026-07-25 moved it here so Submit can
          take the full CTA row and the escape action stays out of
          the primary tap zone. Uses lucide X + a circular hit
          target for the standard "dismiss modal" affordance. */}
      <button
        type="button"
        onClick={onSkipped}
        disabled={isPending}
        aria-label="Skip"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <X size={16} />
      </button>

      <header className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Studio
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Log yesterday&apos;s allotment
        </p>
      </header>

      {/* Fund */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Fund</span>
        <select
          value={fund}
          onChange={(e) => setFund(e.target.value)}
          required
          className="rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
        >
          <option value="">Choose fund…</option>
          {funds.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      {/* Amount */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Amount (₹)
        </span>
        <div className="flex items-center gap-2">
          {amountMode === "ladder" ? (
            <select
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
            >
              {AMOUNT_LADDER.map((v) => (
                <option key={v} value={v}>
                  ₹{v.toLocaleString("en-IN")}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              inputMode="decimal"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
            />
          )}
          <button
            type="button"
            onClick={() =>
              setAmountMode(amountMode === "ladder" ? "custom" : "ladder")
            }
            className="rounded-md border border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {amountMode === "ladder" ? "Custom" : "Ladder"}
          </button>
        </div>
      </label>

      {/* NAV date */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          NAV date
        </span>
        <input
          type="date"
          value={navDate}
          onChange={(e) => setNavDate(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
        />
      </label>

      {/* NAV value (auto-fetched, editable) */}
      <label className="flex flex-col gap-1.5">
        <span className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
          NAV value
          {navLookupState === "loading" && (
            <span className="text-[10px] opacity-70">looking up…</span>
          )}
          {navLookupState === "found" && (
            <span className="text-[10px] text-[hsl(var(--success))]">
              auto-fetched
            </span>
          )}
          {navLookupState === "notfound" && (
            <span
              title={navLookupError ?? undefined}
              className="text-[10px] text-[hsl(var(--warning))]"
            >
              not found — enter manually
            </span>
          )}
        </span>
        <input
          type="number"
          inputMode="decimal"
          step="0.0001"
          value={navValue ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            setNavValue(Number.isFinite(v) && v > 0 ? v : null);
          }}
          placeholder="e.g. 127.373"
          className="rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
        />
      </label>

      {/* Units (computed, read-only) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Units{" "}
          <span className="text-[10px] opacity-60">(amount ÷ NAV)</span>
        </span>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-base tabular-nums text-foreground">
          {units != null ? units.toFixed(4) : "—"}
        </div>
      </div>

      {/* Platform */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Platform
        </span>
        <div className="flex items-center gap-2">
          {platformMode === "list" ? (
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
            >
              {platforms.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={customPlatform}
              onChange={(e) => setCustomPlatform(e.target.value)}
              placeholder="Platform name"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2.5 text-base text-foreground focus:border-[hsl(var(--primary))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.2)]"
            />
          )}
          <button
            type="button"
            onClick={() =>
              setPlatformMode(platformMode === "list" ? "custom" : "list")
            }
            className="rounded-md border border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {platformMode === "list" ? "Custom" : "List"}
          </button>
        </div>
      </label>

      {submitError && (
        <div
          role="alert"
          className="rounded-md border border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-xs text-[hsl(var(--danger))]"
        >
          {submitError}
        </div>
      )}

      {/* Primary action — full-width Submit. User tuning 2026-07-25
          moved Skip out to the top-right X so this row is purely
          the "commit" gesture, no ambiguity about which tap the
          camera should read. Sticky-friendly at the bottom of the
          card so thumbs on portrait phones don't have to stretch
          to the top. */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || isPending}
        className="mt-3 w-full rounded-md bg-[hsl(var(--primary))] py-3 text-sm font-medium text-[hsl(var(--primary-foreground))] shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {isPending ? "Logging…" : "Log allotment"}
      </button>

      {/* Sound lab entry — discreet footer link. Users only need to
          visit this occasionally (once to pick a favourite click,
          rarely to change it), so it lives here rather than
          crowding the primary action row. */}
      <div className="mt-1 flex justify-center">
        <Link
          href="/studio/sounds"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Volume2 size={11} />
          Sound lab
        </Link>
      </div>
    </div>
  );
}
