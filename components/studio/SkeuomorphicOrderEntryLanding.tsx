"use client";

import Link from "next/link";
import { Volume2, X } from "lucide-react";
import {
  useOrderEntryForm,
  ORDER_ENTRY_AMOUNT_LADDER as AMOUNT_LADDER,
} from "@/lib/studio/useOrderEntryForm";
import { SubmitBurst } from "@/components/studio/SubmitBurst";
import { SkeuomorphicSelect } from "@/components/studio/SkeuomorphicSelect";
import { SkeuomorphicDatePicker } from "@/components/studio/SkeuomorphicDatePicker";

const sk = {
  card: {
    background: "linear-gradient(180deg, #f6efdf 0%, #e8d8bc 100%)",
    border: "1px solid #bda47f",
    boxShadow: [
      "0 20px 34px -12px rgba(72, 48, 24, 0.34)",
      "0 5px 10px -3px rgba(72, 48, 24, 0.22)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.75)",
      "inset 0 -1px 0 rgba(120, 86, 45, 0.25)",
    ].join(", "),
  },
  input: {
    background: "linear-gradient(180deg, #fdf8ee 0%, #f4e8d4 100%)",
    border: "1px solid #b29871",
    boxShadow: [
      "inset 0 2px 4px rgba(95, 66, 35, 0.16)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.65)",
    ].join(", "),
  },
  unitsField: {
    background: "linear-gradient(180deg, #eadabd 0%, #dfc9a3 100%)",
    border: "1px solid #b19467",
    boxShadow: [
      "inset 0 3px 5px rgba(107, 77, 42, 0.24)",
      "inset 0 1px 0 rgba(255, 244, 224, 0.55)",
    ].join(", "),
  },
  chip: {
    background: "linear-gradient(180deg, #f3e8d2 0%, #e3d2b2 100%)",
    border: "1px solid #af9166",
    boxShadow: [
      "0 4px 8px rgba(81, 56, 29, 0.20)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.70)",
    ].join(", "),
  },
  closeChip: {
    background: "linear-gradient(180deg, #f4e8d2 0%, #dfc9a3 100%)",
    border: "1px solid #a9875f",
    boxShadow: [
      "0 6px 10px rgba(70, 47, 23, 0.25)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.70)",
    ].join(", "),
  },
  cta: {
    background: "linear-gradient(180deg, #8a6332 0%, #6e4c24 100%)",
    border: "1px solid #5f3f1d",
    boxShadow: [
      "0 10px 16px -8px rgba(74, 48, 19, 0.55)",
      "inset 0 1px 0 rgba(255, 233, 197, 0.32)",
    ].join(", "),
  },
  errorSurface: {
    background: "linear-gradient(180deg, #fdeee9 0%, #f8dfd6 100%)",
    border: "1px solid #d79a86",
    boxShadow: [
      "inset 0 1px 0 rgba(255, 255, 255, 0.8)",
      "inset 0 -1px 0 rgba(184, 97, 73, 0.18)",
    ].join(", "),
  },
} as const;

export function SkeuomorphicOrderEntryLanding({
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
    "w-full appearance-none rounded-2xl px-4 py-3.5 text-base font-medium text-[#3f2e1a] outline-none transition-all placeholder:font-normal placeholder:text-[#806346]";
  const labelCls =
    "px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#765838]";
  const togglePillCls =
    "shrink-0 rounded-2xl px-4 py-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6e5336] transition-transform hover:text-[#4f391f] active:scale-95 disabled:opacity-40";

  return (
    <div
      className="relative mx-auto flex w-full max-w-md flex-col gap-5 rounded-[1.6rem] px-6 py-8"
      style={sk.card}
    >
      <button
        type="button"
        onClick={onSkipped}
        disabled={isPending}
        aria-label="Skip"
        className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-full text-[#6e5336] transition-transform hover:text-[#4f391f] active:scale-95 disabled:opacity-40"
        style={sk.closeChip}
      >
        <X size={16} strokeWidth={2.5} />
      </button>

      <header className="pt-1 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-[#4f391f]">
          Studio
        </h1>
        <p className="mt-1 text-xs font-medium text-[#7a6242]">
          Log yesterday&apos;s allotment
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span className={labelCls}>Fund</span>
        <SkeuomorphicSelect
          value={fund}
          onChange={setFund}
          placeholder="Choose fund..."
          ariaLabel="Fund"
          options={funds.map((f) => ({ value: f, label: f }))}
        />
      </div>

      <label className="flex flex-col gap-2">
        <span className={labelCls}>Amount</span>
        <div className="flex items-center gap-3">
          {amountMode === "ladder" ? (
            <SkeuomorphicSelect
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
              style={sk.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setAmountMode(amountMode === "ladder" ? "custom" : "ladder")
            }
            className={togglePillCls}
            style={sk.chip}
          >
            {amountMode === "ladder" ? "Custom" : "Ladder"}
          </button>
        </div>
      </label>

      <div className="flex flex-col gap-2">
        <span className={labelCls}>NAV date</span>
        <SkeuomorphicDatePicker
          value={navDate}
          onChange={setNavDate}
          ariaLabel="NAV date"
        />
      </div>

      <label className="flex flex-col gap-2">
        <span className={labelCls + " flex items-baseline gap-2"}>
          NAV value
          {navLookupState === "loading" && (
            <span className="text-[9px] font-medium normal-case tracking-normal text-[#8a7050]">
              looking up...
            </span>
          )}
          {navLookupState === "found" && (
            <span className="text-[9px] font-semibold normal-case tracking-normal text-[#2f6b3e]">
              auto-fetched
            </span>
          )}
          {navLookupState === "notfound" && (
            <span
              title={navLookupError ?? undefined}
              className="text-[9px] font-semibold normal-case tracking-normal text-[#94602a]"
            >
              not found - enter manually
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
          style={sk.input}
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          Units
          <span className="ml-1 text-[9px] font-medium normal-case tracking-normal text-[#8a7050]">
            (amount / NAV)
          </span>
        </span>
        <div
          className="rounded-2xl px-4 py-3.5 text-base font-medium tabular-nums text-[#4f391f]"
          style={sk.unitsField}
        >
          {units != null ? units.toFixed(4) : "-"}
        </div>
      </div>

      <label className="flex flex-col gap-2">
        <span className={labelCls}>Platform</span>
        <div className="flex items-center gap-3">
          {platformMode === "list" ? (
            <SkeuomorphicSelect
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
              style={sk.input}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setPlatformMode(platformMode === "list" ? "custom" : "list")
            }
            className={togglePillCls}
            style={sk.chip}
          >
            {platformMode === "list" ? "Custom" : "List"}
          </button>
        </div>
      </label>

      {submitError && (
        <div
          role="alert"
          className="rounded-2xl px-4 py-3 text-xs font-medium text-[#8f3f2c]"
          style={sk.errorSurface}
        >
          {submitError}
        </div>
      )}

      <div className="relative mt-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || isPending}
          className="w-full rounded-2xl py-4 text-sm font-bold tracking-wide text-[#fff7e8] transition-transform hover:scale-[1.01] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          style={sk.cta}
        >
          {isPending ? "Logging..." : "Log allotment"}
        </button>
        {submitPulseKey > 0 && (
          <SubmitBurst key={submitPulseKey} theme="skeuomorphic" />
        )}
      </div>

      <div className="mt-1 flex justify-center">
        <Link
          href="/studio/sounds"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[#8a7050] transition-colors hover:text-[#4f391f]"
        >
          <Volume2 size={11} strokeWidth={2.5} />
          Sound lab
        </Link>
      </div>
    </div>
  );
}
