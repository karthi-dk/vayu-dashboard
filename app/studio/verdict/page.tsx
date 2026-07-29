"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Play, PlayCircle, RotateCcw } from "lucide-react";
import { VerdictReactive } from "@/components/studio/VerdictReactive";
import {
  playVerdict,
  type VerdictTier,
} from "@/lib/studio/sounds";
import { cn, fmtCompactINR } from "@/lib/utils";

/**
 * /studio/verdict — the verdict tier preview page.
 *
 * The 1D tile on the Studio reveal fires a sign-tiered reaction
 * at t=5500ms after data lands. In production the user only sees
 * whichever tier matches their actual portfolio's 1D move — which
 * makes calibrating the animation intensity across tiers hard: to
 * compare a green day to a red day the user would need both back-
 * to-back, which markets don't deliver on demand.
 *
 * This page fixes that. Four mock 1 DAY tiles, one per tier, with
 * a Play button that fires the tile's full audiovisual reaction
 * immediately (bypassing the reveal cascade's 5500ms delay). A
 * "Play all" button cycles through the tiers with a 2.5s gap so
 * the whole set can be evaluated in ~10 seconds.
 *
 * Tier taxonomy — 4 tiers (VerdictTier in lib/studio/sounds.ts)
 * -------------------------------------------------------------
 *   • big-green — DENSE: triple scale bounce (1.12) + wider
 *     rotate + 12 sparkles + dual-ring emerald halo, 1.5s.
 *     6-note 3-octave chime audio (C5-E5-G5-C6-E6-G6).
 *   • green — standard double-bounce (1.08) + 8 sparkles + single-
 *     ring emerald halo, 1.5s. 3-note C-E-G chime, ~0.5s.
 *   • flat — silent, no visual reaction.
 *   • red — HEAVY DENSE: pre-recoil wince → 20% deep collapse →
 *     multi-stage recovery + 14px settle + ±5.5° tilt + triple-
 *     ring red halo, 2.0s. 5-note D-minor descent audio
 *     (F5-D5-C5-Bb4-A4).
 *
 * The taxonomy was 5 tiers in a prior iteration (with a big-red
 * split from red). Three rounds of calibration showed every small-
 * loss reaction kept getting pushed toward the big-loss reaction,
 * so the tier collapsed. Wins stay split because a +1% day
 * genuinely deserves a bigger celebration than a +0.1% day.
 *
 * Signature elements you can look for
 * -----------------------------------
 * Two distinct halo shapes let the reviewer disambiguate at a
 * glance: dual-ring (big-green, 4 keyframes) and triple-ring
 * (red, 5 keyframes). Red also has the pre-recoil wince — a
 * two-beat "tension → release → recovery" grammar that's unique
 * to it and separates it from every other reaction.
 *
 * User-selectable sound variants
 * ------------------------------
 * The green (incl. big-green) and red synth choices are user
 * selectable — pick a style on /studio/sounds and both this
 * preview and the production 1 DAY tile will play the chosen
 * synth. See VERDICT_GREEN_VARIANTS and VERDICT_RED_VARIANTS
 * in lib/studio/sounds.ts.
 *
 * Sight/sound routing:
 *   • Visual: `VerdictReactive` from components/studio, passed
 *     `triggerDelayMs={0}` so the reaction fires on mount instead
 *     of waiting for STUDIO_TIMING.VERDICT_BEGIN.
 *   • Audio: `playVerdict(inr, pct)` from lib/studio/sounds with
 *     mock values that resolve to the intended tier via
 *     resolveVerdictTier(). Both sight and sound consume the same
 *     resolver output, so they never disagree on which tier fires.
 *
 * Not gated by NODE_ENV — accessible in prod builds so the user
 * can tune preferences without a redeploy, same convention as
 * /studio/sounds. Not linked from main nav; navigate directly.
 */

type TierPreview = {
  id: VerdictTier;
  label: string;
  threshold: string;
  mockInr: number;
  mockPct: number;
  tone: "gain" | "loss" | "neutral";
  audiovisualNote: string;
};

/** Tier mocks — inr/pct chosen to fall unambiguously into each
 *  tier's threshold band (see resolveVerdictTier in
 *  lib/studio/sounds.ts). Values are also displayed in the card
 *  body so the tester can see exactly what the resolver receives. */
const TIERS: readonly TierPreview[] = [
  {
    id: "big-green",
    label: "Big green",
    threshold: "+% ≥ 1%",
    mockInr: 48_000,
    mockPct: 0.012,
    tone: "gain",
    audiovisualNote:
      "Dense: 6-note extended chime C5-E5-G5-C6-E6-G6 (3-octave rise, ~1.15s) + triple scale bounce (max +12%) + wide ±4° rotate + 12 sparkles + dual-ring emerald halo (peak → aftershock). 1.5s visual — paired with green.",
  },
  {
    id: "green",
    label: "Green",
    threshold: "0 < +% < 1%",
    mockInr: 1_600,
    mockPct: 0.004,
    tone: "gain",
    audiovisualNote:
      "3-note C-E-G chime (~0.5s) + scale double-bounce (max +8%) + ±2.5° jiggle + 8 sparkles + single-ring emerald halo. 1.5s visual — paired with big-green; the ~1s of silent visual after the chime lets the halo pulse land as a coda.",
  },
  {
    id: "flat",
    label: "Flat",
    threshold: "|Δ|<₹1 or |%|<0.05%",
    mockInr: 0,
    mockPct: 0,
    tone: "neutral",
    audiovisualNote: "Silent — no sound, no visual reaction.",
  },
  {
    id: "red",
    label: "Red",
    threshold: "any negative move",
    mockInr: -60_000,
    mockPct: -0.015,
    tone: "loss",
    audiovisualNote:
      "Heavy dense: 5-note D-minor descent F5-D5-C5-Bb4-A4 (~1.30s) + pre-recoil wince (subtle 3% tighten) → deep collapse (20% squish) → multi-stage recovery + 14px settle + ±5.5° tilt + triple-ring red halo (peak → mid echo → soft echo → out). 2.0s visual.",
  },
] as const;

/** ~2.5s gap between tiers in Play-all mode. Green tiers run 1.5s
 *  and red runs 2.0s, with audio at 0.5-1.30s per tier; 2.5s
 *  spacing means each reaction fully completes with ~500ms of
 *  clean silence before the next one starts, so the ear can
 *  register each distinctly rather than blurring them together.
 *  Total sequence time: 3 non-silent tiers × 2.5s = 7.5s (flat is
 *  included but produces no audio-visual output). */
const PLAY_ALL_GAP_MS = 2500;

export default function VerdictPreviewPage() {
  // Each tier has its own trigger counter. Incrementing forces
  // VerdictReactive to remount (via `key`), which fires the
  // reaction from a fresh not-yet-reacted state. Initial values
  // are all 0; VerdictReactive is passed `animate={counter > 0}`
  // so the initial page load doesn't fire all 4 reactions at
  // once (which it would if animate defaulted to true — the
  // useEffect would run immediately with triggerDelayMs=0).
  const [triggers, setTriggers] = useState<Record<VerdictTier, number>>({
    "big-green": 0,
    green: 0,
    flat: 0,
    red: 0,
  });
  const [playingAll, setPlayingAll] = useState(false);

  const triggerTier = useCallback((preview: TierPreview) => {
    setTriggers((prev) => ({
      ...prev,
      [preview.id]: prev[preview.id] + 1,
    }));
    playVerdict(preview.mockInr, preview.mockPct);
  }, []);

  const playAll = useCallback(() => {
    if (playingAll) return;
    setPlayingAll(true);
    TIERS.forEach((preview, i) => {
      window.setTimeout(() => {
        triggerTier(preview);
        // Release the disabled state 1.2s after the last tier
        // fires (matches the longest visual + audio duration so
        // the button stays disabled until the sequence is
        // audibly complete).
        if (i === TIERS.length - 1) {
          window.setTimeout(() => setPlayingAll(false), 1200);
        }
      }, i * PLAY_ALL_GAP_MS);
    });
  }, [playingAll, triggerTier]);

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Verdict tiers
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Preview the 1 DAY tile&apos;s reactive coda. Fires at reveal
              t=5500ms in production; here you can trigger any tier on demand
              to compare.
            </p>
          </div>
          <Link
            href="/studio"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcw size={12} />
            Back to Studio
          </Link>
        </header>

        {/* Info banner — explains the 4-tier taxonomy and points
            at /studio/sounds for the variant picker. */}
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-[11px]">
          <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            4 tiers
          </span>
          <div className="text-foreground/80">
            <p>
              The 1 DAY tile reacts to your day&apos;s move with one of four
              tiers. Every loss gets the same reaction regardless of
              magnitude (losses shouldn&apos;t escalate visually the way wins
              do); wins scale into a bigger celebration above +1%.
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              <li>
                <strong>big-green</strong> — <em>dense</em>: triple bounce
                (scale 1.12) + 12 sparkles + <strong>dual-ring</strong>{" "}
                emerald halo at <strong>1.5s</strong>
              </li>
              <li>
                <strong>green</strong> — standard double bounce (1.08) + 8
                sparkles + single-ring halo at <strong>1.5s</strong>
              </li>
              <li>
                <strong>flat</strong> — silent, no reaction
              </li>
              <li>
                <strong>red</strong> — <em>heavy dense</em>: pre-recoil
                wince → 20% deep collapse → multi-stage recovery + 14px
                settle + <strong>triple-ring</strong> red halo at{" "}
                <strong>2.0s</strong>
              </li>
            </ul>
            <p className="mt-1.5">
              Green and red synth choices are user-selectable — pick a style
              on{" "}
              <Link
                href="/studio/sounds"
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                /studio/sounds
              </Link>{" "}
              and both this preview and the production 1 DAY tile will play
              the chosen synth.
            </p>
          </div>
        </div>

        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-[11px] text-muted-foreground">
            Cycles through all 4 tiers with a{" "}
            {(PLAY_ALL_GAP_MS / 1000).toFixed(1)}s gap between each so you
            can compare intensities in ~10 seconds.
          </div>
          <button
            type="button"
            onClick={playAll}
            disabled={playingAll}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[hsl(var(--success))] px-3 text-xs font-medium text-white transition-colors hover:bg-[hsl(var(--success))]/90 disabled:opacity-60"
          >
            <PlayCircle size={13} fill="currentColor" />
            {playingAll ? "Playing…" : "Play all tiers"}
          </button>
        </div>

        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {TIERS.map((preview) => (
            <TierCard
              key={preview.id}
              preview={preview}
              triggerCount={triggers[preview.id]}
              onPlay={() => triggerTier(preview)}
            />
          ))}
        </ul>

        <div className="mt-8 rounded-lg border border-border bg-muted/20 px-4 py-3 text-[11px] text-muted-foreground">
          <p>
            <strong className="text-foreground">Sight and sound routing:</strong>{" "}
            visual reaction is rendered by{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              VerdictReactive
            </code>{" "}
            (same component the real 1 DAY tile uses); audio is fired via{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              playVerdict(inr, pct)
            </code>{" "}
            which looks up the currently active green + red variants and
            calls their synths. Both sight and sound consume the same tier
            from{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              resolveVerdictTier(inr, pct)
            </code>{" "}
            so they never disagree on which tier fires.
          </p>
          <p className="mt-2">
            <strong className="text-foreground">Prefers-reduced-motion:</strong>{" "}
            if your OS is set to reduce motion, the audio is suppressed (see{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              shouldPlay()
            </code>
            ). The visual still renders but the halo pulse and transforms
            respect framer-motion&apos;s reduced-motion defaults.
          </p>
        </div>
      </div>
    </div>
  );
}

/** One preview card. Contains the tier metadata (label, threshold,
 *  audiovisual note), the mock 1 DAY tile wrapped in VerdictReactive,
 *  the raw inr/pct values that feed the resolver, and a Play button.
 *
 *  `triggerCount` is used two ways:
 *    1. `animate={triggerCount > 0}` — suppresses the initial mount
 *       from firing (VerdictReactive's useEffect early-returns).
 *    2. `key={triggerCount}` — remounts on each increment so the
 *       reaction fires from a fresh not-yet-reacted state. */
function TierCard({
  preview,
  triggerCount,
  onPlay,
}: {
  preview: TierPreview;
  triggerCount: number;
  onPlay: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold capitalize text-foreground">
            {preview.label}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {preview.threshold}
          </p>
        </div>
        <button
          type="button"
          onClick={onPlay}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
        >
          <Play size={11} fill="currentColor" />
          Play
        </button>
      </div>

      {/* Padding around the mock tile so the halo pulse (up to
          10px outside the tile edge on red) has room to render
          without clipping against the card's border. */}
      <div className="px-2 py-3">
        <VerdictReactive
          key={triggerCount}
          tier={preview.id}
          animate={triggerCount > 0}
          triggerDelayMs={0}
        >
          <MockDayTile mockInr={preview.mockInr} tone={preview.tone} />
        </VerdictReactive>
      </div>

      <div className="flex flex-col gap-1 border-t border-border/50 pt-3 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-2 font-mono">
          <span className="text-muted-foreground/70">inr:</span>
          <span className="text-foreground">
            {preview.mockInr >= 0 ? "+" : ""}
            {preview.mockInr.toLocaleString("en-IN")}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground/70">pct:</span>
          <span className="text-foreground">
            {preview.mockPct >= 0 ? "+" : ""}
            {(preview.mockPct * 100).toFixed(2)}%
          </span>
        </div>
        <p className="mt-1 leading-relaxed">{preview.audiovisualNote}</p>
      </div>
    </li>
  );
}

/** Mock 1 DAY tile — replicates the real Stat tile's markup from
 *  StatsRow so the preview looks identical to the production tile.
 *  Kept as a local component (not shared with Stat in StatsRow)
 *  because it renders a hardcoded label + non-animated value —
 *  the real Stat receives its value as a RollUpNumber for the
 *  reveal cascade, which isn't relevant here. */
function MockDayTile({
  mockInr,
  tone,
}: {
  mockInr: number;
  tone: "gain" | "loss" | "neutral";
}) {
  return (
    <div className="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-background px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        1 Day
      </span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "gain" && "text-[hsl(var(--success))]",
          tone === "loss" && "text-[hsl(var(--danger))]",
          tone === "neutral" && "text-foreground"
        )}
      >
        {Math.abs(mockInr) < 1 ? "₹0" : fmtCompactINR(mockInr, { sign: true })}
      </span>
      <span className="text-[10px] text-muted-foreground/80">{"\u00A0"}</span>
    </div>
  );
}
