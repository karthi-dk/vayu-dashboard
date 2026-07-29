"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Volume2, X } from "lucide-react";
import { logMfTransaction } from "@/app/actions";
import { lookupNavForFundOnDate } from "@/app/studio/actions";
import { knownFundCodes } from "@/lib/mf/fundCatalog";
import { PLATFORMS } from "@/lib/mf/platform";
import { unlockAudio } from "@/lib/studio/sounds";
import { NeumorphicSelect } from "@/components/studio/NeumorphicSelect";
import { NeumorphicDatePicker } from "@/components/studio/NeumorphicDatePicker";

/**
 * NeumorphicOrderEntryLanding — style-prototype clone of
 * OrderEntryLanding, mounted only at /studio/neumorphic.
 *
 * The business logic (state, NAV auto-fetch, submit handler,
 * forceError dev hook, TEST_MODE handling) is a verbatim copy from
 * OrderEntryLanding so this route can hit real DB writes (or the
 * synthetic error branch) without any behavioural drift. Only the
 * visual layer is swapped:
 *
 *   • Soft blue-gray surface (#e0e5ec) instead of the app theme
 *   • Extruded ("raised") cards for interactive containers
 *   • Debossed ("inset") shells for input fields
 *   • Deeper inset for the read-only Units display
 *   • Coloured raised primary CTA — keeps affordance without
 *     shattering the monochrome palette
 *   • Native <select> preserved for mobile UX parity with /studio
 *
 * Neumorphic shadow tokens live in the `nm` object below rather
 * than Tailwind's shadow-[…] arbitrary syntax — the comma-separated
 * hex-colour box-shadow values are cleaner as JS strings than as
 * class fragments, and switching to `style={…}` keeps the JIT
 * scanner from having to grok escaping oddities. Trade-off: no
 * pseudo-selector (hover/active) shadow morphs in this prototype;
 * those can be added via a `<style jsx>` block or the shadow-[…]
 * variant if we promote the design out of prototype.
 *
 * Palette rationale
 * -----------------
 * The classic Plyuto Dribbble palette (soft blue-gray, near-white
 * highlights, cool depth shadows) reads best on portrait mobile
 * where /studio actually lives, and photographs cleanly under
 * screen recording. Success (soft green) and warning (soft amber)
 * chips are dialled DOWN in saturation so they don't visually
 * spike out of the pastel surface — the goal is meditative
 * calmness, not urgency.
 */

const IS_TEST_MODE = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";
const AMOUNT_LADDER = [10000, 11000, 12000, 13000, 14000, 15000];

// Neumorphic depth tokens. Each entry maps directly to a
// `style={nm.xxx}` prop on the corresponding surface. See the
// "shadow tokens" comment in the header block for why we're not
// using Tailwind's arbitrary-value shadow-[…] syntax here.
const nm = {
  raisedMd: {
    boxShadow: "-8px -8px 16px #ffffff, 8px 8px 16px #a3b1c6",
  },
  raisedSm: {
    boxShadow: "-4px -4px 8px #ffffff, 4px 4px 8px #a3b1c6",
  },
  inset: {
    boxShadow: "inset 4px 4px 8px #a3b1c6, inset -4px -4px 8px #ffffff",
  },
  insetDeep: {
    boxShadow: "inset 6px 6px 12px #a3b1c6, inset -6px -6px 12px #ffffff",
  },
  ctaRaised: {
    boxShadow: "-4px -4px 10px #ffffff, 4px 4px 10px #a3b1c6",
  },
  errorInset: {
    boxShadow: "inset 3px 3px 6px #d5b8b8, inset -3px -3px 6px #ffe5e5",
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

export function NeumorphicOrderEntryLanding({
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

  // Shared class fragments to keep the JSX below scannable. All
  // colour values are inlined hex from the neumorphic palette (not
  // Vayu's theme HSL vars) so this component stays visually
  // isolated regardless of app-level dark/light mode. Chevron
  // background-image is a data-URI SVG so we avoid a network hop
  // and can tint it to the muted palette (#8a94a7).
  const inputCls =
    "w-full appearance-none rounded-2xl bg-[#e0e5ec] px-4 py-3 text-base text-[#4a5568] outline-none transition-all placeholder:text-[#a6b0c0]";
  // (selectCls with data-URI chevron dropped — all three <select>
  // fields are now custom NeumorphicSelect components that render
  // their own chevron via lucide-react.)
  const labelCls =
    "px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8a94a7]";
  const togglePillCls =
    "shrink-0 rounded-2xl bg-[#e0e5ec] px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8a94a7] transition-all active:text-[#4a5568] disabled:opacity-40";

  return (
    // Card container — raised from the page surface (which is also
    // #e0e5ec, so the shadows are what carry the "the card is a
    // physical object" affordance). Rounded-[2rem] instead of the
    // stock rounded-md because neumorphic surfaces read better
    // with generous corner radii — flat corners look 'flat' and
    // undermine the extrusion illusion.
    <div
      className="relative mx-auto flex w-full max-w-md flex-col gap-5 rounded-[2rem] bg-[#e0e5ec] px-6 py-8"
      style={nm.raisedMd}
    >
      {/* Close / skip — small raised circle mirroring the
          top-right X in the production /studio card. Same
          onSkipped handler so behaviour is identical; only the
          shadow language differs. */}
      <button
        type="button"
        onClick={onSkipped}
        disabled={isPending}
        aria-label="Skip"
        className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-full bg-[#e0e5ec] text-[#8a94a7] transition-colors hover:text-[#4a5568] disabled:opacity-40"
        style={nm.raisedSm}
      >
        <X size={16} />
      </button>

      <header className="pt-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-[#4a5568]">
          Studio
        </h1>
        <p className="mt-1 text-xs text-[#8a94a7]">
          Log yesterday&apos;s allotment
        </p>
      </header>

      {/* Fund — custom NeumorphicSelect so the panel + option
          rows are themed. Empty-value "Choose fund…" prompt is
          handled by the placeholder prop, so we don't need a
          sentinel row in options. */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>Fund</span>
        <NeumorphicSelect
          value={fund}
          onChange={setFund}
          placeholder="Choose fund…"
          ariaLabel="Fund"
          options={funds.map((f) => ({ value: f, label: f }))}
        />
      </div>

      {/* Amount — ladder/custom toggle preserved */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>Amount (₹)</span>
        <div className="flex items-center gap-3">
          {amountMode === "ladder" ? (
            <NeumorphicSelect
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
              style={nm.inset}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setAmountMode(amountMode === "ladder" ? "custom" : "ladder")
            }
            className={togglePillCls}
            style={nm.raisedSm}
          >
            {amountMode === "ladder" ? "Custom" : "Ladder"}
          </button>
        </div>
      </label>

      {/* NAV date — custom NeumorphicDatePicker so the calendar
          panel picks up the pastel palette instead of falling
          back to the OS-native picker (which renders a bright
          white card with system-blue selection strip and breaks
          the neumorphic surface immediately). */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>NAV date</span>
        <NeumorphicDatePicker
          value={navDate}
          onChange={setNavDate}
          ariaLabel="NAV date"
        />
      </div>

      {/* NAV value — auto-fetched with status chip */}
      <label className="flex flex-col gap-2">
        <span className={labelCls + " flex items-baseline gap-2"}>
          NAV value
          {navLookupState === "loading" && (
            <span className="text-[9px] font-normal normal-case tracking-normal text-[#8a94a7]">
              looking up…
            </span>
          )}
          {navLookupState === "found" && (
            <span className="text-[9px] font-normal normal-case tracking-normal text-[#5cb582]">
              auto-fetched
            </span>
          )}
          {navLookupState === "notfound" && (
            <span
              title={navLookupError ?? undefined}
              className="text-[9px] font-normal normal-case tracking-normal text-[#c68f3d]"
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
          style={nm.inset}
        />
      </label>

      {/* Units — deeper inset since it's read-only. The extra
          shadow depth signals "you can't press this", matching
          disabled-input conventions in the neumorphic canon. */}
      <div className="flex flex-col gap-2">
        <span className={labelCls}>
          Units{" "}
          <span className="text-[9px] font-normal normal-case tracking-normal opacity-60">
            (amount ÷ NAV)
          </span>
        </span>
        <div
          className="rounded-2xl bg-[#dce1e8] px-4 py-3 text-base tabular-nums text-[#4a5568]"
          style={nm.insetDeep}
        >
          {units != null ? units.toFixed(4) : "—"}
        </div>
      </div>

      {/* Platform */}
      <label className="flex flex-col gap-2">
        <span className={labelCls}>Platform</span>
        <div className="flex items-center gap-3">
          {platformMode === "list" ? (
            <NeumorphicSelect
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
              style={nm.inset}
            />
          )}
          <button
            type="button"
            onClick={() =>
              setPlatformMode(platformMode === "list" ? "custom" : "list")
            }
            className={togglePillCls}
            style={nm.raisedSm}
          >
            {platformMode === "list" ? "Custom" : "List"}
          </button>
        </div>
      </label>

      {submitError && (
        <div
          role="alert"
          className="rounded-2xl bg-[#f0d9d9] px-4 py-3 text-xs text-[#c04a4a]"
          style={nm.errorInset}
        >
          {submitError}
        </div>
      )}

      {/* Primary CTA — colored fill breaks pure neumorphic doctrine
          (which prefers monochrome buttons distinguished only by
          shadow direction), but the accessibility win outweighs
          the aesthetic purity: a first-time user should have zero
          doubt about which surface is the primary action. The
          soft-indigo #6c7fdd keeps the pastel calmness while
          giving the CTA a clear visual anchor. */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || isPending}
        className="mt-2 w-full rounded-2xl bg-[#6c7fdd] py-4 text-sm font-medium tracking-wide text-white transition-all hover:bg-[#7d8de5] disabled:cursor-not-allowed disabled:opacity-40"
        style={nm.ctaRaised}
      >
        {isPending ? "Logging…" : "Log allotment"}
      </button>

      <div className="mt-1 flex justify-center">
        <Link
          href="/studio/sounds"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[#8a94a7] transition-colors hover:text-[#4a5568]"
        >
          <Volume2 size={11} />
          Sound lab
        </Link>
      </div>
    </div>
  );
}
