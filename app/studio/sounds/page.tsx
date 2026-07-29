"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Play, RotateCcw, Volume2 } from "lucide-react";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import {
  CLICK_VARIANT_LIST,
  CRACKER_VARIANT_LIST,
  ROLLUP_VARIANT_LIST,
  VERDICT_GREEN_VARIANT_LIST,
  VERDICT_RED_VARIANT_LIST,
  getActiveClickVariant,
  getActiveCrackerVariant,
  getActiveRollupVariant,
  getActiveVerdictGreenVariant,
  getActiveVerdictRedVariant,
  playClickVariant,
  playCrackerVariant,
  playRollupVariant,
  playVerdictGreenBigVariant,
  playVerdictGreenVariant,
  playVerdictRedVariant,
  setActiveClickVariant,
  setActiveCrackerVariant,
  setActiveRollupVariant,
  setActiveVerdictGreenVariant,
  setActiveVerdictRedVariant,
  type ClickVariantId,
  type CrackerVariantId,
  type RollupVariantId,
  type VerdictGreenVariantId,
  type VerdictRedVariantId,
} from "@/lib/studio/sounds";
import { cn } from "@/lib/utils";

/**
 * /studio/sounds — the sound lab.
 *
 * Five sections:
 *   1. CLICK — 10 variants of the tap sound used for every user
 *              gesture on /studio (dropdowns, dates, Submit, etc.).
 *   2. ROLLUP — 15 variants of the "numbers counting up" sound that
 *               fires when the progress + stats cascade animates.
 *   3. SKY-CRACKER — 16 variants of the celebration burst that fires
 *                    alongside the Lottie confetti in the
 *                    'celebrating' stage right after a successful
 *                    submit, BEFORE the reveal chart draws. The
 *                    whistle→burst family (7 variants) is grouped
 *                    at the top of the section because that's the
 *                    signature sky-cracker aesthetic.
 *   4. VERDICT GREEN — 18 variants of the "good day" coda played
 *                      when the 1D tile settles positive. Each
 *                      variant has TWO synths (compact for small
 *                      wins, extended for big wins ≥+1%) so a
 *                      single selection covers both green tiers.
 *   5. VERDICT RED — 18 variants of the "bad day" coda played when
 *                    the 1D tile settles negative. All losses use
 *                    the same variant regardless of magnitude
 *                    (4-tier taxonomy, no big-red split).
 *
 * Each section shares the same UX: a pinned "Currently active"
 * callout at the top, then a list of variants with Play (preview)
 * and Set active (persist) buttons. Verdict-green rows have a
 * dual Play (Small / Big) so the user can audition both magnitudes
 * before committing.
 *
 * Selections persist in localStorage — every subsequent tap /
 * cascade / verdict in /studio uses the chosen variant. The
 * globally-mounted <StudioClickSound /> is also on this page, so
 * clicks here play the currently-active click sound too — an
 * in-situ A/B test surface.
 *
 * NOT gated by NODE_ENV — the page is accessible in prod builds so
 * users can tune their preferences without a redeploy. It's just
 * not linked from the main nav; only from the Studio order-entry
 * card footer and from /studio/verdict.
 */
export default function StudioSoundLabPage() {
  const [activeClick, setActiveClick] = useState<ClickVariantId>("layered");
  const [activeRollup, setActiveRollupState] =
    useState<RollupVariantId>("odometer");
  const [activeCracker, setActiveCrackerState] =
    useState<CrackerVariantId>("rocket_whistle");
  const [activeVerdictGreen, setActiveVerdictGreenState] =
    useState<VerdictGreenVariantId>("major_bell");
  const [activeVerdictRed, setActiveVerdictRedState] =
    useState<VerdictRedVariantId>("minor_descent");

  useEffect(() => {
    // Read localStorage once mounted (SSR-safe).
    setActiveClick(getActiveClickVariant());
    setActiveRollupState(getActiveRollupVariant());
    setActiveCrackerState(getActiveCrackerVariant());
    setActiveVerdictGreenState(getActiveVerdictGreenVariant());
    setActiveVerdictRedState(getActiveVerdictRedVariant());

    const onClickChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: ClickVariantId }>).detail;
      if (detail?.id) setActiveClick(detail.id);
    };
    const onRollupChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: RollupVariantId }>).detail;
      if (detail?.id) setActiveRollupState(detail.id);
    };
    const onCrackerChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: CrackerVariantId }>).detail;
      if (detail?.id) setActiveCrackerState(detail.id);
    };
    const onVerdictGreenChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: VerdictGreenVariantId }>).detail;
      if (detail?.id) setActiveVerdictGreenState(detail.id);
    };
    const onVerdictRedChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: VerdictRedVariantId }>).detail;
      if (detail?.id) setActiveVerdictRedState(detail.id);
    };
    window.addEventListener("studio:click-variant-changed", onClickChange);
    window.addEventListener("studio:rollup-variant-changed", onRollupChange);
    window.addEventListener("studio:cracker-variant-changed", onCrackerChange);
    window.addEventListener(
      "studio:verdict-green-variant-changed",
      onVerdictGreenChange
    );
    window.addEventListener(
      "studio:verdict-red-variant-changed",
      onVerdictRedChange
    );
    return () => {
      window.removeEventListener("studio:click-variant-changed", onClickChange);
      window.removeEventListener(
        "studio:rollup-variant-changed",
        onRollupChange
      );
      window.removeEventListener(
        "studio:cracker-variant-changed",
        onCrackerChange
      );
      window.removeEventListener(
        "studio:verdict-green-variant-changed",
        onVerdictGreenChange
      );
      window.removeEventListener(
        "studio:verdict-red-variant-changed",
        onVerdictRedChange
      );
    };
  }, []);

  return (
    <div className="min-h-dvh">
      <StudioClickSound />
      <StudioClickPulse />

      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Sound lab
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Pick the tap, roll-up, sky-cracker, and verdict sounds.
              Selection persists on this device.
            </p>
          </div>
          <Link
            href="/studio"
            className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcw size={12} />
            Back to Studio
          </Link>
        </header>

        {/* ── CLICK SECTION ──────────────────────────────────────── */}
        <SectionHeader
          title="Click sound"
          subtitle="Fires on every tap — buttons, dropdowns, date picker, timeframe pills."
        />
        <ActiveCallout
          activeName={
            CLICK_VARIANT_LIST.find((v) => v.id === activeClick)?.name ?? "—"
          }
          onPlay={() => void playClickVariant(activeClick)}
        />
        <ul className="mt-4 flex flex-col gap-2">
          {CLICK_VARIANT_LIST.map((variant) => (
            <VariantRow
              key={variant.id}
              name={variant.name}
              description={variant.description}
              isActive={variant.id === activeClick}
              onPlay={() => void playClickVariant(variant.id)}
              onSetActive={() => {
                setActiveClickVariant(variant.id);
                void playClickVariant(variant.id);
              }}
            />
          ))}
        </ul>

        {/* ── ROLLUP SECTION ─────────────────────────────────────── */}
        <div className="mt-10">
          <SectionHeader
            title="Roll-up sound"
            subtitle="Fires when the numbers cascade after a submit — daily progress + stats grids."
          />
          <ActiveCallout
            activeName={
              ROLLUP_VARIANT_LIST.find((v) => v.id === activeRollup)?.name ??
              "—"
            }
            onPlay={() => void playRollupVariant(activeRollup)}
          />
          <ul className="mt-4 flex flex-col gap-2">
            {ROLLUP_VARIANT_LIST.map((variant) => (
              <VariantRow
                key={variant.id}
                name={variant.name}
                description={variant.description}
                isActive={variant.id === activeRollup}
                onPlay={() => void playRollupVariant(variant.id)}
                onSetActive={() => {
                  setActiveRollupVariant(variant.id);
                  void playRollupVariant(variant.id);
                }}
              />
            ))}
          </ul>
        </div>

        {/* ── SKY-CRACKER SECTION ────────────────────────────────── */}
        <div className="mt-10">
          <SectionHeader
            title="Sky-cracker"
            subtitle="Fires alongside the confetti Lottie right after Submit. First 7 are whistle→burst variants (the signature sky-cracker style); rest offer other flavours."
          />
          <ActiveCallout
            activeName={
              CRACKER_VARIANT_LIST.find((v) => v.id === activeCracker)?.name ??
              "—"
            }
            onPlay={() => void playCrackerVariant(activeCracker)}
          />
          <ul className="mt-4 flex flex-col gap-2">
            {CRACKER_VARIANT_LIST.map((variant) => (
              <VariantRow
                key={variant.id}
                name={variant.name}
                description={variant.description}
                isActive={variant.id === activeCracker}
                onPlay={() => void playCrackerVariant(variant.id)}
                onSetActive={() => {
                  setActiveCrackerVariant(variant.id);
                  void playCrackerVariant(variant.id);
                }}
              />
            ))}
          </ul>
        </div>

        {/* ── VERDICT GREEN SECTION ──────────────────────────────── */}
        <div className="mt-10">
          <SectionHeader
            title="Verdict — Green (win days)"
            subtitle="Fires 5500ms after the reveal cascade when the day's 1D move is positive. Each variant has TWO synths — Small for daily wins, Big for +1% days — so one selection covers both green tiers."
          />
          <ActiveCallout
            activeName={
              VERDICT_GREEN_VARIANT_LIST.find(
                (v) => v.id === activeVerdictGreen
              )?.name ?? "—"
            }
            onPlay={() => void playVerdictGreenVariant(activeVerdictGreen)}
            secondaryPlay={{
              label: "Big",
              onPlay: () => void playVerdictGreenBigVariant(activeVerdictGreen),
            }}
          />
          <ul className="mt-4 flex flex-col gap-2">
            {VERDICT_GREEN_VARIANT_LIST.map((variant) => (
              <VerdictGreenVariantRow
                key={variant.id}
                name={variant.name}
                description={variant.description}
                isActive={variant.id === activeVerdictGreen}
                onPlaySmall={() => void playVerdictGreenVariant(variant.id)}
                onPlayBig={() => void playVerdictGreenBigVariant(variant.id)}
                onSetActive={() => {
                  setActiveVerdictGreenVariant(variant.id);
                  void playVerdictGreenBigVariant(variant.id);
                }}
              />
            ))}
          </ul>
        </div>

        {/* ── VERDICT RED SECTION ────────────────────────────────── */}
        <div className="mt-10">
          <SectionHeader
            title="Verdict — Red (loss days)"
            subtitle="Fires 5500ms after the reveal cascade when the day's 1D move is negative. All losses share the same variant — 4-tier taxonomy, no big-red split. Every variant is intentionally warm and quiet; nothing punitive."
          />
          <ActiveCallout
            activeName={
              VERDICT_RED_VARIANT_LIST.find((v) => v.id === activeVerdictRed)
                ?.name ?? "—"
            }
            onPlay={() => void playVerdictRedVariant(activeVerdictRed)}
          />
          <ul className="mt-4 flex flex-col gap-2">
            {VERDICT_RED_VARIANT_LIST.map((variant) => (
              <VariantRow
                key={variant.id}
                name={variant.name}
                description={variant.description}
                isActive={variant.id === activeVerdictRed}
                onPlay={() => void playVerdictRedVariant(variant.id)}
                onSetActive={() => {
                  setActiveVerdictRedVariant(variant.id);
                  void playVerdictRedVariant(variant.id);
                }}
              />
            ))}
          </ul>
        </div>

        <p className="mt-8 text-[11px] text-muted-foreground">
          All sounds are synthesised via the Web Audio API — no assets
          shipped. Drop MP3s into{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            public/assets/sounds/&#123;click,swoosh,ding,rollup,cracker&#125;.mp3
          </code>{" "}
          to override with your own clips. Verdict sounds are synth-only
          (no MP3 override) — the variant registry is the source of truth.
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          To compare the verdict tiers side-by-side (green vs big-green vs
          red visual reactions),{" "}
          <Link
            href="/studio/verdict"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            open the verdict preview page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

/** Small centered section title + subtitle — used to introduce each
 *  section without repeating the layout. */
function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/** Pinned "Currently active" callout. Reused across sections. Verdict
 *  green passes a `secondaryPlay` so the top callout also offers both
 *  Small and Big preview buttons for the currently-active variant —
 *  matches the dual-play buttons on each row so nothing feels
 *  inconsistent between "here's your active" vs "here are the
 *  choices". */
function ActiveCallout({
  activeName,
  onPlay,
  secondaryPlay,
}: {
  activeName: string;
  onPlay: () => void;
  secondaryPlay?: { label: string; onPlay: () => void };
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.06)] px-3 py-2.5">
      <Volume2 size={16} className="text-[hsl(var(--primary))]" />
      <div className="flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Currently active
        </div>
        <div className="text-sm font-semibold text-foreground">
          {activeName}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onPlay}
          className="flex h-8 items-center gap-1.5 rounded-md border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] px-2.5 text-xs font-medium text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)/0.2)]"
        >
          <Play size={11} />
          {secondaryPlay ? "Small" : "Play"}
        </button>
        {secondaryPlay && (
          <button
            type="button"
            onClick={secondaryPlay.onPlay}
            className="flex h-8 items-center gap-1.5 rounded-md border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] px-2.5 text-xs font-medium text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary)/0.2)]"
          >
            <Play size={11} />
            {secondaryPlay.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** A single variant row in a picker list. Agnostic to variant TYPE —
 *  receives display strings + event handlers, so the same component
 *  powers click, rollup, cracker, and verdict-red sections. */
function VariantRow({
  name,
  description,
  isActive,
  onPlay,
  onSetActive,
}: {
  name: string;
  description: string;
  isActive: boolean;
  onPlay: () => void;
  onSetActive: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors",
        isActive
          ? "border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.05)]"
          : "border-border bg-background"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-foreground">{name}</div>
          {isActive && (
            <span className="flex items-center gap-1 rounded-full border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[hsl(var(--primary))]">
              <Check size={9} />
              Active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onPlay}
          aria-label={`Play ${name}`}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Play size={12} />
        </button>
        <button
          type="button"
          onClick={onSetActive}
          disabled={isActive}
          className={cn(
            "h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
            isActive
              ? "cursor-default border border-border text-muted-foreground"
              : "border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
          )}
        >
          {isActive ? "Active" : "Set active"}
        </button>
      </div>
    </li>
  );
}

/** Variant row for the verdict-green section — like VariantRow but
 *  with TWO play buttons: Small (compact synth for daily wins) and
 *  Big (extended synth for +1% days). One variant selection covers
 *  both magnitudes, but users need to hear both before picking so
 *  they know how the style scales.
 *
 *  Buttons are text-labelled ("Small" / "Big") rather than pure
 *  icon buttons so the distinction is unambiguous — a play icon
 *  alone would leave "which one is small?" ambiguous. */
function VerdictGreenVariantRow({
  name,
  description,
  isActive,
  onPlaySmall,
  onPlayBig,
  onSetActive,
}: {
  name: string;
  description: string;
  isActive: boolean;
  onPlaySmall: () => void;
  onPlayBig: () => void;
  onSetActive: () => void;
}) {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors sm:flex-row sm:items-start sm:gap-3",
        isActive
          ? "border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.05)]"
          : "border-border bg-background"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-foreground">{name}</div>
          {isActive && (
            <span className="flex items-center gap-1 rounded-full border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.1)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[hsl(var(--primary))]">
              <Check size={9} />
              Active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onPlaySmall}
          aria-label={`Play ${name} (small win)`}
          className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Play size={10} />
          Small
        </button>
        <button
          type="button"
          onClick={onPlayBig}
          aria-label={`Play ${name} (big win)`}
          className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Play size={10} />
          Big
        </button>
        <button
          type="button"
          onClick={onSetActive}
          disabled={isActive}
          className={cn(
            "h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
            isActive
              ? "cursor-default border border-border text-muted-foreground"
              : "border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
          )}
        >
          {isActive ? "Active" : "Set active"}
        </button>
      </div>
    </li>
  );
}
