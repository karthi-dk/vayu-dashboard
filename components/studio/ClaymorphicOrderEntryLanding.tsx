"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Calendar,
  Divide,
  IndianRupee,
  Rocket,
  Smartphone,
  TrendingUp,
  Volume2,
  Wallet,
  X,
} from "lucide-react";
import {
  useOrderEntryForm,
  ORDER_ENTRY_AMOUNT_LADDER as AMOUNT_LADDER,
} from "@/lib/studio/useOrderEntryForm";
import { SubmitBurst } from "@/components/studio/SubmitBurst";
import { ClaymorphicSelect } from "@/components/studio/ClaymorphicSelect";
import { ClaymorphicDatePicker } from "@/components/studio/ClaymorphicDatePicker";

/**
 * ClaymorphicOrderEntryLanding — style-prototype clone of
 * OrderEntryLanding for /studio/claymorphic.
 *
 * Visual language (v3 — coloured)
 * -------------------------------
 * Building on v2's chunky 3D pillow surfaces, this pass adds:
 *
 *   1. A chunky violet Rocket badge in the header — anchors the
 *      top with the same "hero pill" gesture the reveal stage
 *      uses for the value pill.
 *   2. Colour-per-field icon chips beside each label — six
 *      distinct hues (violet / emerald / amber / sky / rose /
 *      fuchsia) that also mirror the palette used on the
 *      reveal-stage stat tiles, so the entry form → reveal
 *      hand-off feels like one continuous coloured universe.
 *   3. Kept the violet gradient CTA and amped shadows from v2.
 *
 * Icon-to-hue rationale
 *   • FUND      → violet   (primary "which basket")
 *   • AMOUNT    → emerald  (money / growth)
 *   • NAV DATE  → amber    (calendar / time-of-day warmth)
 *   • NAV VALUE → sky      (chart / data cool)
 *   • UNITS     → rose     (computed / hot output)
 *   • PLATFORM  → fuchsia  (variety / brand-picker)
 *
 * The mapping is decorative, not semantic — feel free to swap.
 *
 * Business logic (state, NAV auto-fetch, submit handler,
 * forceError dev hook, TEST_MODE tagging) is untouched from
 * v1 — behaviour parity with /studio.
 */

/**
 * Clay surface tokens (v3 — colour-anchored).
 *
 * Depth recipe (unchanged from v2):
 *   1. Outer drop shadow at low alpha — "rests on soft ground"
 *   2. Inset top highlight — "top-lit clay puff"
 *   3. Inset bottom shadow — "underside curves away"
 */
const cm = {
  card: {
    background: "#ffffff",
    boxShadow: [
      "0 30px 60px -12px rgba(60, 60, 100, 0.22)",
      "0 12px 24px -4px rgba(60, 60, 100, 0.10)",
      "inset 0 12px 16px -6px rgba(255, 255, 255, 1)",
      "inset 0 -12px 20px -6px rgba(60, 60, 100, 0.07)",
    ].join(", "),
  },
  input: {
    background: "#f0f2fa",
    boxShadow: [
      "inset 0 4px 8px 0 rgba(60, 60, 100, 0.12)",
      "inset 0 -1px 2px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
  unitsField: {
    background: "#e8ebf5",
    boxShadow: [
      "inset 0 5px 10px 0 rgba(60, 60, 100, 0.14)",
      "inset 0 -1px 2px 0 rgba(255, 255, 255, 0.5)",
    ].join(", "),
  },
  chip: {
    background: "#ffffff",
    boxShadow: [
      "0 10px 18px -4px rgba(60, 60, 100, 0.18)",
      "0 3px 6px -1px rgba(60, 60, 100, 0.07)",
      "inset 0 3px 5px -1px rgba(255, 255, 255, 1)",
      "inset 0 -3px 6px -2px rgba(60, 60, 100, 0.06)",
    ].join(", "),
  },
  closeChip: {
    background: "#ffffff",
    boxShadow: [
      "0 12px 20px -4px rgba(60, 60, 100, 0.20)",
      "inset 0 3px 5px -1px rgba(255, 255, 255, 1)",
      "inset 0 -3px 6px -2px rgba(60, 60, 100, 0.06)",
    ].join(", "),
  },
  cta: {
    background: "linear-gradient(180deg, #a78bfa 0%, #7c3aed 100%)",
    boxShadow: [
      "0 20px 36px -8px rgba(124, 58, 237, 0.55)",
      "0 8px 16px -3px rgba(124, 58, 237, 0.30)",
      "inset 0 6px 10px -2px rgba(255, 255, 255, 0.40)",
      "inset 0 -6px 10px -2px rgba(0, 0, 0, 0.22)",
    ].join(", "),
  },
  errorSurface: {
    background: "#fef2f2",
    boxShadow: [
      "inset 0 3px 6px 0 rgba(220, 38, 38, 0.12)",
      "inset 0 -1px 2px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
} as const;

/**
 * Field-icon chip palette. Each entry is a self-contained clay
 * "candy" — vertical gradient fill + tinted drop shadow +
 * subtle top highlight + bottom inset. The tinted drop shadow
 * is the key move: each chip sheds its own hue onto the
 * surrounding periwinkle, so the form reads as a rainbow of
 * small pillows rather than "grey form with coloured accents".
 *
 * Shadow alpha is deliberately higher than the card/panel
 * shadows because these chips are SMALL (24px) — smaller
 * elements need bolder shadows to read as 3D at the same
 * distance from the viewer. Same optical principle as UI icon
 * kits scaling shadow radius inversely with element size.
 */
const ICON_CHIPS = {
  violet: {
    background: "linear-gradient(180deg, #a78bfa 0%, #7c3aed 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(124, 58, 237, 0.50)",
      "0 2px 4px -1px rgba(124, 58, 237, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.15)",
    ].join(", "),
  },
  emerald: {
    background: "linear-gradient(180deg, #4ade80 0%, #16a34a 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(22, 163, 74, 0.50)",
      "0 2px 4px -1px rgba(22, 163, 74, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.15)",
    ].join(", "),
  },
  amber: {
    background: "linear-gradient(180deg, #fbbf24 0%, #d97706 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(217, 119, 6, 0.50)",
      "0 2px 4px -1px rgba(217, 119, 6, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.12)",
    ].join(", "),
  },
  sky: {
    background: "linear-gradient(180deg, #60a5fa 0%, #2563eb 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(37, 99, 235, 0.50)",
      "0 2px 4px -1px rgba(37, 99, 235, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.15)",
    ].join(", "),
  },
  rose: {
    background: "linear-gradient(180deg, #fb7185 0%, #e11d48 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(225, 29, 72, 0.50)",
      "0 2px 4px -1px rgba(225, 29, 72, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.15)",
    ].join(", "),
  },
  fuchsia: {
    background: "linear-gradient(180deg, #e879f9 0%, #c026d3 100%)",
    boxShadow: [
      "0 6px 12px -2px rgba(192, 38, 211, 0.50)",
      "0 2px 4px -1px rgba(192, 38, 211, 0.30)",
      "inset 0 2px 3px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 3px -1px rgba(0, 0, 0, 0.15)",
    ].join(", "),
  },
} as const;

type ChipTone = keyof typeof ICON_CHIPS;

/**
 * FieldIcon — a small clay chip that hosts a lucide icon.
 * Purely presentational (aria-hidden) since the adjacent text
 * label carries the semantic meaning. Fixed 24×24 chip with a
 * 12–14px icon inside, rendered in white against the gradient.
 *
 * Kept as a component (not just inline styles) so the size and
 * shape stay consistent across every call site — bumping the
 * chip from 24px to 28px is a one-liner here.
 */
function FieldIcon({
  tone,
  children,
}: {
  tone: ChipTone;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-white"
      style={ICON_CHIPS[tone]}
    >
      {children}
    </span>
  );
}

export function ClaymorphicOrderEntryLanding({
  onSubmitted,
  onSkipped,
}: {
  onSubmitted: () => void;
  onSkipped: () => void;
}) {
  const {
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
  } = useOrderEntryForm({ onSubmitted });

  const inputCls =
    "w-full appearance-none rounded-2xl px-4 py-3.5 text-base font-medium text-slate-800 outline-none transition-all placeholder:font-normal placeholder:text-slate-400";
  const labelCls =
    "flex items-center gap-2 px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500";
  const togglePillCls =
    "shrink-0 rounded-2xl px-4 py-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-600 transition-transform hover:text-slate-800 active:scale-95 disabled:opacity-40";

  return (
    <div
      className="relative mx-auto flex w-full max-w-md flex-col gap-5 rounded-[2rem] px-6 py-8"
      style={cm.card}
    >
      <button
        type="button"
        onClick={onSkipped}
        disabled={isPending}
        aria-label="Skip"
        className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-full text-slate-400 transition-transform hover:text-slate-700 active:scale-95 disabled:opacity-40"
        style={cm.closeChip}
      >
        <X size={16} strokeWidth={2.5} />
      </button>

      {/* Studio header — chunky Rocket badge + title on the same
          line. The badge is a size-up of the field icon chips
          (h-11 w-11 vs h-6 w-6) — same clay shadow recipe,
          same violet gradient. Reads as the "master chip" that
          the field chips echo. */}
      <header className="pt-1">
        <div className="flex items-center justify-center gap-3">
          <span
            aria-hidden
            className="inline-flex h-11 w-11 items-center justify-center rounded-2xl text-white"
            style={ICON_CHIPS.violet}
          >
            <Rocket size={20} strokeWidth={2.25} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">
            Studio
          </h1>
        </div>
        <p className="mt-1.5 text-center text-xs font-medium text-slate-500">
          Log yesterday&apos;s allotment
        </p>
      </header>

      {/* Fund */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="violet">
            <Wallet size={12} strokeWidth={2.5} />
          </FieldIcon>
          Fund
        </span>
        <ClaymorphicSelect
          value={fund}
          onChange={setFund}
          placeholder="Choose fund…"
          ariaLabel="Fund"
          options={funds.map((f) => ({ value: f, label: f }))}
        />
      </div>

      {/* Amount */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="emerald">
            <IndianRupee size={12} strokeWidth={2.75} />
          </FieldIcon>
          Amount
        </span>
        <div className="flex items-center gap-3">
          {amountMode === "ladder" ? (
            <ClaymorphicSelect
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
              style={cm.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setAmountMode(amountMode === "ladder" ? "custom" : "ladder")
            }
            className={togglePillCls}
            style={cm.chip}
          >
            {amountMode === "ladder" ? "Custom" : "Ladder"}
          </button>
        </div>
      </label>

      {/* NAV date */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="amber">
            <Calendar size={12} strokeWidth={2.5} />
          </FieldIcon>
          NAV date
        </span>
        <ClaymorphicDatePicker
          value={navDate}
          onChange={setNavDate}
          ariaLabel="NAV date"
        />
      </div>

      {/* NAV value */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="sky">
            <TrendingUp size={12} strokeWidth={2.5} />
          </FieldIcon>
          NAV value
          {navLookupState === "loading" && (
            <span className="text-[9px] font-medium normal-case tracking-normal text-slate-400">
              looking up…
            </span>
          )}
          {navLookupState === "found" && (
            <span className="text-[9px] font-semibold normal-case tracking-normal text-emerald-600">
              auto-fetched
            </span>
          )}
          {navLookupState === "notfound" && (
            <span
              title={navLookupError ?? undefined}
              className="text-[9px] font-semibold normal-case tracking-normal text-amber-600"
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
          style={cm.input}
        />
      </label>

      {/* Units — DEEPER inset than the regular inputs to signal
          "not editable". The clay grammar for read-only is "more
          pressed in", same semantic mapping as neumorphic's
          insetDeep. */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="rose">
            <Divide size={12} strokeWidth={3} />
          </FieldIcon>
          Units
          <span className="text-[9px] font-medium normal-case tracking-normal text-slate-400">
            (amount ÷ NAV)
          </span>
        </span>
        <div
          className="rounded-2xl px-4 py-3.5 text-base font-medium tabular-nums text-slate-700"
          style={cm.unitsField}
        >
          {units != null ? units.toFixed(4) : "—"}
        </div>
      </div>

      {/* Platform */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>
          <FieldIcon tone="fuchsia">
            <Smartphone size={12} strokeWidth={2.5} />
          </FieldIcon>
          Platform
        </span>
        <div className="flex items-center gap-3">
          {platformMode === "list" ? (
            <ClaymorphicSelect
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
              style={cm.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setPlatformMode(platformMode === "list" ? "custom" : "list")
            }
            className={togglePillCls}
            style={cm.chip}
          >
            {platformMode === "list" ? "Custom" : "List"}
          </button>
        </div>
      </label>

      {submitError && (
        <div
          role="alert"
          className="rounded-2xl px-4 py-3 text-xs font-medium text-red-700"
          style={cm.errorSurface}
        >
          {submitError}
        </div>
      )}

      {/* Primary CTA — the show-stopper. Violet gradient with a
          bold coloured drop-shadow. Active-scale for a subtle
          "squishing the clay" feel on press. */}
      <div className="relative mt-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || isPending}
          className="w-full rounded-2xl py-4 text-sm font-bold tracking-wide text-white transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          style={cm.cta}
        >
          {isPending ? "Logging…" : "Log allotment"}
        </button>
        {submitPulseKey > 0 && (
          <SubmitBurst key={submitPulseKey} theme="claymorphic" />
        )}
      </div>

      <div className="mt-1 flex justify-center">
        <Link
          href="/studio/sounds"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-600"
        >
          <Volume2 size={11} strokeWidth={2.5} />
          Sound lab
        </Link>
      </div>
    </div>
  );
}
