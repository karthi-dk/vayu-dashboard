"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Volume2, X } from "lucide-react";
import { logMfTransaction } from "@/app/actions";
import { lookupNavForFundOnDate } from "@/app/studio/actions";
import { knownFundCodes } from "@/lib/mf/fundCatalog";
import { PLATFORMS } from "@/lib/mf/platform";
import { unlockAudio } from "@/lib/studio/sounds";
import { GlassmorphicSelect } from "@/components/studio/GlassmorphicSelect";
import { GlassmorphicDatePicker } from "@/components/studio/GlassmorphicDatePicker";

/**
 * GlassmorphicOrderEntryLanding — style-prototype clone of
 * OrderEntryLanding, mounted at /studio/glassmorphic.
 *
 * Business logic (state, NAV auto-fetch, submit handler, forceError
 * dev hook, TEST_MODE handling) is a verbatim copy from the
 * production entry form — behaviour parity with /studio.
 *
 * Visual language
 * ---------------
 * • Aurora gradient backdrop applied by the parent page —
 *   without a vivid backdrop, glassmorphism reduces to
 *   "semi-transparent white blob on grey", which is why the
 *   page owns the background rather than the card.
 * • Card surface: rgba(255,255,255,0.10) + blur(24px)
 *   saturate(180%) — the saturate boost is what makes the
 *   colours BEHIND the glass feel richer than reality, the
 *   signature Apple / Windows 11 "material" look.
 * • Inputs: same recipe, lower alpha (0.06-0.08) and lighter
 *   blur (12px) so they read as pressed INTO the card.
 * • CTA: fuchsia→indigo linear-gradient at 85% opacity with a
 *   soft-pink drop-shadow — the accent that gives the surface
 *   its energy.
 * • Text: white with opacity variants (60% muted labels, 40%
 *   placeholders) — hard fills would fight the transparency.
 */

const IS_TEST_MODE = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";
const AMOUNT_LADDER = [10000, 11000, 12000, 13000, 14000, 15000];

// Glass surface tokens. Applied via style={gm.xxx}. Duplicated
// across the three glassmorphic components so each file stays
// self-contained during the prototype phase; extract to
// lib/glass.ts if the design is promoted.
const gm = {
  card: {
    background: "rgba(255, 255, 255, 0.10)",
    backdropFilter: "blur(24px) saturate(180%)",
    WebkitBackdropFilter: "blur(24px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.18)",
    boxShadow: "0 8px 32px 0 rgba(15, 23, 42, 0.35)",
  },
  input: {
    background: "rgba(255, 255, 255, 0.08)",
    backdropFilter: "blur(12px) saturate(180%)",
    WebkitBackdropFilter: "blur(12px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.15)",
  },
  unitsField: {
    background: "rgba(0, 0, 0, 0.15)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
  },
  chip: {
    background: "rgba(255, 255, 255, 0.10)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255, 255, 255, 0.18)",
  },
  closeChip: {
    background: "rgba(255, 255, 255, 0.10)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255, 255, 255, 0.20)",
  },
  cta: {
    background:
      "linear-gradient(135deg, rgba(240, 171, 252, 0.9), rgba(165, 180, 252, 0.9))",
    border: "1px solid rgba(255, 255, 255, 0.30)",
    boxShadow: "0 12px 32px 0 rgba(240, 171, 252, 0.30)",
  },
  errorSurface: {
    background: "rgba(220, 38, 38, 0.15)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(252, 165, 165, 0.30)",
  },
} as const;

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
  const today = new Date(`${y}-${m}-${d}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

type NavLookupState = "idle" | "loading" | "found" | "notfound";

export function GlassmorphicOrderEntryLanding({
  onSubmitted,
  onSkipped,
}: {
  onSubmitted: () => void;
  onSkipped: () => void;
}) {
  const funds = knownFundCodes();
  const platforms = PLATFORMS.filter((p) => p.code !== "test");

  const [fund, setFund] = useState<string>("");
  const [amount, setAmount] = useState<number>(AMOUNT_LADDER[0]);
  const [amountMode, setAmountMode] = useState<"ladder" | "custom">("ladder");
  const [navDate, setNavDate] = useState<string>(yesterdayISO_IST());
  const [navValue, setNavValue] = useState<number | null>(null);
  const [platform, setPlatform] = useState<string>("indmoney");
  const [customPlatform, setCustomPlatform] = useState<string>("");
  const [platformMode, setPlatformMode] = useState<"list" | "custom">("list");

  const [navLookupState, setNavLookupState] =
    useState<NavLookupState>("idle");
  const [navLookupError, setNavLookupError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

    void unlockAudio();
    void import("@/components/studio/CelebrationOverlay").catch(() => {});
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

  // Shared class fragments. Text colours are white with opacity
  // variants throughout — hard fills would break the glass
  // illusion by looking painted-on rather than translucent.
  const inputCls =
    "w-full appearance-none rounded-2xl px-4 py-3 text-base text-white outline-none transition-all placeholder:text-white/40";
  const labelCls =
    "px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/60";
  const togglePillCls =
    "shrink-0 rounded-2xl px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/85 transition-colors hover:text-white disabled:opacity-40";

  return (
    // Card container — the primary glass surface. Rounded generously
    // (2rem) to feel object-like against the aurora. All depth cues
    // are carried by the shadow + border + backdrop-blur combo; no
    // extra layering needed.
    <div
      className="relative mx-auto flex w-full max-w-md flex-col gap-5 rounded-[2rem] px-6 py-8"
      style={gm.card}
    >
      <button
        type="button"
        onClick={onSkipped}
        disabled={isPending}
        aria-label="Skip"
        className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-full text-white/75 transition-colors hover:text-white disabled:opacity-40"
        style={gm.closeChip}
      >
        <X size={16} />
      </button>

      <header className="pt-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Studio
        </h1>
        <p className="mt-1 text-xs text-white/60">
          Log yesterday&apos;s allotment
        </p>
      </header>

      {/* Fund */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>Fund</span>
        <GlassmorphicSelect
          value={fund}
          onChange={setFund}
          placeholder="Choose fund…"
          ariaLabel="Fund"
          options={funds.map((f) => ({ value: f, label: f }))}
        />
      </div>

      {/* Amount */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>Amount (₹)</span>
        <div className="flex items-center gap-3">
          {amountMode === "ladder" ? (
            <GlassmorphicSelect
              className="flex-1"
              value={String(amount)}
              onChange={(v) => setAmount(Number(v))}
              ariaLabel="Amount"
              options={AMOUNT_LADDER.map((v) => ({
                value: String(v),
                label: `₹${v.toLocaleString("en-IN")}`,
              }))}
            />
          ) : (
            <input
              type="number"
              inputMode="decimal"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className={inputCls + " flex-1"}
              style={gm.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setAmountMode(amountMode === "ladder" ? "custom" : "ladder")
            }
            className={togglePillCls}
            style={gm.chip}
          >
            {amountMode === "ladder" ? "Custom" : "Ladder"}
          </button>
        </div>
      </label>

      {/* NAV date */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>NAV date</span>
        <GlassmorphicDatePicker
          value={navDate}
          onChange={setNavDate}
          ariaLabel="NAV date"
        />
      </div>

      {/* NAV value */}
      <label className="flex flex-col gap-2">
        <span className={labelCls + " flex items-baseline gap-2"}>
          NAV value
          {navLookupState === "loading" && (
            <span className="text-[9px] font-normal normal-case tracking-normal text-white/50">
              looking up…
            </span>
          )}
          {navLookupState === "found" && (
            <span className="text-[9px] font-normal normal-case tracking-normal text-emerald-300">
              auto-fetched
            </span>
          )}
          {navLookupState === "notfound" && (
            <span
              title={navLookupError ?? undefined}
              className="text-[9px] font-normal normal-case tracking-normal text-amber-200"
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
          className={inputCls}
          style={gm.input}
        />
      </label>

      {/* Units — read-only, darker backing so it reads as
          "not editable" against the lighter input fields. Same
          semantic role as the neumorphic deeper-inset variant. */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          Units{" "}
          <span className="text-[9px] font-normal normal-case tracking-normal text-white/40">
            (amount ÷ NAV)
          </span>
        </span>
        <div
          className="rounded-2xl px-4 py-3 text-base tabular-nums text-white/90"
          style={gm.unitsField}
        >
          {units != null ? units.toFixed(4) : "—"}
        </div>
      </div>

      {/* Platform */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>Platform</span>
        <div className="flex items-center gap-3">
          {platformMode === "list" ? (
            <GlassmorphicSelect
              className="flex-1"
              value={platform}
              onChange={setPlatform}
              ariaLabel="Platform"
              options={platforms.map((p) => ({
                value: p.code,
                label: p.label,
              }))}
            />
          ) : (
            <input
              type="text"
              value={customPlatform}
              onChange={(e) => setCustomPlatform(e.target.value)}
              placeholder="Platform name"
              className={inputCls + " flex-1"}
              style={gm.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setPlatformMode(platformMode === "list" ? "custom" : "list")
            }
            className={togglePillCls}
            style={gm.chip}
          >
            {platformMode === "list" ? "Custom" : "List"}
          </button>
        </div>
      </label>

      {submitError && (
        <div
          role="alert"
          className="rounded-2xl px-4 py-3 text-xs text-red-100"
          style={gm.errorSurface}
        >
          {submitError}
        </div>
      )}

      {/* Primary CTA — fuchsia→indigo gradient. The bright accent
          against the muted glass surface makes the tap zone
          unmistakable. Text is deep-indigo for readable contrast
          on the light gradient (white text on pastel gradient is
          the classic glassmorphism legibility trap). */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || isPending}
        className="mt-2 w-full rounded-2xl py-4 text-sm font-semibold tracking-wide text-indigo-950 transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        style={gm.cta}
      >
        {isPending ? "Logging…" : "Log allotment"}
      </button>

      <div className="mt-1 flex justify-center">
        <Link
          href="/studio/sounds"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-white/50 transition-colors hover:text-white/80"
        >
          <Volume2 size={11} />
          Sound lab
        </Link>
      </div>
    </div>
  );
}
