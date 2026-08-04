"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STUDIO_TIMING } from "@/components/studio/RevealDashboard";
import type { VerdictTier } from "@/lib/studio/sounds";

/**
 * VerdictReactive — wraps any tile with a sign-tiered audiovisual
 * reaction that fires after a configurable delay. Used in two
 * places:
 *
 *   1. StatsRow's 1 DAY tile: fires at STUDIO_TIMING.VERDICT_BEGIN
 *      (5500ms after reveal-content mount) in sync with the
 *      playVerdict() audio call in RevealDashboard.
 *   2. /studio/verdict preview page: fires with delay=0 on
 *      button click, letting the tester compare all 4 tiers
 *      side-by-side without waiting for a full reveal cycle.
 *
 * Tier taxonomy: 4 tiers, not 5
 * -----------------------------
 * A prior iteration (V1) had five tiers with big-red split from
 * red. That distinction was collapsed after three rounds of
 * calibration on /studio/verdict — every red-day iteration kept
 * pushing the small-loss reaction toward the big-loss reaction,
 * so the "which loss is big enough for the heavy treatment?"
 * calibration problem was solved by treating all losses the same.
 * Wins are different: a +1% day genuinely deserves a bigger
 * celebration than a +0.1% day, so big-green vs green stays split.
 *
 * Current tier mapping
 * --------------------
 *   • big-green — DENSE: triple scale bounce (7 keyframes,
 *     scale 1→1.12→1.04→1.09→1.02→1.06→1) + wide ±4° oscillating
 *     rotate + 12 emerald sparkles + DUAL-RING emerald halo
 *     (4-keyframe boxShadow: transparent → 8px peak → 4px echo
 *     → transparent). 1.5s duration.
 *
 *   • green — standard: double bounce (scale 1→1.08→1.03→1.06→1)
 *     + ±2.5° rotate jiggle + 8 sparkles + single-ring emerald
 *     halo (3-keyframe: transparent → 6px peak → transparent).
 *     1.5s duration.
 *
 *   • flat — silent, no visual. Rounding-noise days deserve no
 *     verdict.
 *
 *   • red — HEAVY DENSE: pre-recoil wince (scaleY 1→0.97, tiny y
 *     drift and rotate before the collapse) → deep collapse
 *     (scaleY 0.80) → multi-stage recovery (0.90 → 0.96 → 1) with
 *     14px y-settle and ±5.5° tilt swing + TRIPLE-RING red halo
 *     (5-keyframe: transparent → 10px @ 0.55α → 5px mid echo
 *     → 2px soft echo → transparent). 2.0s duration.
 *
 * V2 signatures
 * -------------
 * Two distinct halo shapes let the user perceive tier at a glance:
 *
 *   • DUAL-RING (big-green): 4-keyframe boxShadow. Peak →
 *     aftershock → silence. Reserved for big-green.
 *
 *   • TRIPLE-RING (red): 5-keyframe boxShadow. Peak → mid echo
 *     → soft echo → out. Reserved for red — signals "loss weight"
 *     without needing punitive amplitude.
 *
 * The PRE-RECOIL WINCE (red only) is the strongest single
 * differentiator between red and any other tier. The tile
 * tightens briefly BEFORE the deep collapse, giving red a
 * two-beat quality (tension → release → recovery) that reads as
 * emotional presence rather than a mechanical bounce.
 *
 * Design principle
 * ----------------
 * Celebrate wins loudly, acknowledge losses gently, ignore noise.
 * Green tiers use scale + rotate (uniform vibrant pulse); red
 * uses scaleY + y + rotate (settle/deflate). The visual grammar
 * mirrors the sonic gesture: chime-up rises, minor-descend falls.
 *
 * Colours are hardcoded rgba because framer-motion doesn't
 * interpolate CSS var(--danger) / var(--success) strings cleanly.
 * rgb(34, 197, 94) = Tailwind green-500 and rgb(239, 68, 68) =
 * Tailwind red-500 — close enough to the app's --success and
 * --danger tokens that any drift is invisible against a pulsing
 * halo.
 *
 * Trigger and lifecycle
 * ---------------------
 * The reaction fires once per mount (via a setTimeout gated by
 * `animate`). Force a re-trigger by changing the `key` prop on
 * the wrapping element — that's how the preview page's "Play"
 * button works. The cleanup function resets the internal latch
 * so a re-mounted instance starts from a clean "not-yet-reacted"
 * state.
 *
 * Skip path (animate=false) renders instantly with no reaction,
 * matching the rest of the reveal's Skip behaviour.
 */

/** Per-tier reaction config. Keeping this as a pure resolver
 *  function so each tier's anatomy lives in one contiguous block.
 *  Adding a new tier or tweaking one doesn't require chasing
 *  keyframes across separate ternaries. */
type TierConfig = {
  transform: Record<string, number[]>;
  /** boxShadow keyframes — 3 for single-ring (green), 4 for
   *  dual-ring (big-green), 5 for triple-ring (red). framer-motion
   *  interpolates across however many keyframes the caller
   *  provides, so different tiers can have different ring counts
   *  within the same animate call. */
  halo: string[] | undefined;
  duration: number;
};

function resolveTierConfig(tier: VerdictTier): TierConfig {
  switch (tier) {
    // ── Big-green DENSE ──────────────────────────────────
    // Triple scale bounce (7 keyframes vs green's 5-keyframe
    // double-bounce). Wider oscillating rotate (±4° vs ±2.5°).
    // Dual-ring emerald halo. Duration matches green (1.5s) —
    // the "denser" quality comes from packing 7 scale keyframes
    // into the same 1.5s window that green fits 5 into. Rate of
    // change per unit time is higher = denser without needing
    // bigger amplitude bumps.
    case "big-green":
      return {
        transform: {
          scale: [1, 1.12, 1.04, 1.09, 1.02, 1.06, 1],
          rotate: [0, -4, 4, -2, 2, -0.8, 0],
        },
        halo: [
          "0 0 0 0 rgba(34, 197, 94, 0)",
          "0 0 0 8px rgba(34, 197, 94, 0.5)",
          "0 0 0 4px rgba(34, 197, 94, 0.25)",
          "0 0 0 0 rgba(34, 197, 94, 0)",
        ],
        duration: 1.5,
      };

    // ── Green ────────────────────────────────────────────
    // Standard double-bounce. Duration paired with big-green
    // at 1.5s so both green tiers occupy the same on-screen
    // time budget; differentiation is via keyframe density and
    // amplitude, not extra duration.
    case "green":
      return {
        transform: {
          scale: [1, 1.08, 1.03, 1.06, 1],
          rotate: [0, -2.5, 2.5, -1.2, 0],
        },
        halo: [
          "0 0 0 0 rgba(34, 197, 94, 0)",
          "0 0 0 6px rgba(34, 197, 94, 0.42)",
          "0 0 0 0 rgba(34, 197, 94, 0)",
        ],
        duration: 1.5,
      };

    // ── Red (heavy-dense) ────────────────────────────────
    // Signature elements:
    //   • Pre-recoil wince: scaleY 1 → 0.97 with barely any y
    //     or rotate movement. Reads as the tile tightening up
    //     before the collapse. Occupies the first ~17% of the
    //     animation duration.
    //   • Deep collapse: scaleY 0.97 → 0.80 (20% squish).
    //   • Multi-stage recovery: 0.80 → 0.90 → 0.96 → 1 across
    //     three stages, feels weighty and gradual rather than a
    //     single spring back.
    //   • y translation matches: 0 → 1 (during wince) → 14
    //     (deep sag) → 8 → 3 → 0 (settle home).
    //   • rotate carries the emotional lean: 0 → 0.5 (wince,
    //     tiny stiffening) → -5.5 (leaning into loss) → 2
    //     (over-correction) → -0.8 → 0.3 → 0 (dampened wobble
    //     to home). 7 keyframes.
    //   • Triple-ring red halo (5 boxShadow keyframes):
    //     transparent → 10px @ 0.55 α → 5px @ 0.32 α → 2px
    //     @ 0.15 α → transparent.
    //   • 2.0s duration.
    //
    // Any negative move gets this treatment regardless of
    // magnitude. See the top-of-file taxonomy explanation for
    // why losses are single-tiered.
    case "red":
      return {
        transform: {
          scaleY: [1, 0.97, 0.8, 0.9, 0.96, 1],
          y: [0, 1, 14, 8, 3, 0],
          rotate: [0, 0.5, -5.5, 2, -0.8, 0.3, 0],
        },
        halo: [
          "0 0 0 0 rgba(239, 68, 68, 0)",
          "0 0 0 10px rgba(239, 68, 68, 0.55)",
          "0 0 0 5px rgba(239, 68, 68, 0.32)",
          "0 0 0 2px rgba(239, 68, 68, 0.15)",
          "0 0 0 0 rgba(239, 68, 68, 0)",
        ],
        duration: 2.0,
      };

    case "flat":
    default:
      return { transform: {}, halo: undefined, duration: 0 };
  }
}

/** Particle count per green tier. Red gets zero — losses don't
 *  rain sad particles. Markets are red ~40% of days; a particle-
 *  shower per red day would train a small daily flinch. Sigh +
 *  settle + halo pulse is expressive acknowledgement without
 *  punishment. */
function resolveParticleCount(tier: VerdictTier): number {
  switch (tier) {
    case "big-green":
      return 12;
    case "green":
      return 8;
    default:
      return 0;
  }
}

export function VerdictReactive({
  children,
  tier,
  animate,
  triggerDelayMs = STUDIO_TIMING.VERDICT_BEGIN,
}: {
  children: ReactNode;
  tier: VerdictTier;
  animate: boolean;
  /** Milliseconds to wait after mount before firing the reaction.
   *  Defaults to STUDIO_TIMING.VERDICT_BEGIN (5500ms) for the
   *  production Studio reveal. Pass 0 (or a small value) on the
   *  preview page so a button-triggered remount fires the
   *  reaction immediately. */
  triggerDelayMs?: number;
}) {
  const [reacted, setReacted] = useState(false);
  useEffect(() => {
    if (!animate || tier === "flat") return;
    const id = window.setTimeout(() => setReacted(true), triggerDelayMs);
    return () => {
      window.clearTimeout(id);
      // Reset the reaction latch on unmount / re-fire so a
      // preview-page re-play (which recreates this component via
      // key change on the parent tree) starts from a clean
      // "not-yet-reacted" state and the reaction plays again.
      setReacted(false);
    };
  }, [animate, tier, triggerDelayMs]);

  const config = resolveTierConfig(tier);
  const isGreen = tier === "big-green" || tier === "green";
  const particleCount = resolveParticleCount(tier);

  // Compose the animate prop only when the reaction has fired.
  // Before that, an empty object leaves the tile in its initial
  // pose (no scale/rotate/y/boxShadow interference).
  const activeAnimate = reacted
    ? {
        ...config.transform,
        ...(config.halo ? { boxShadow: config.halo } : {}),
      }
    : {};

  return (
    <motion.div
      className="studio-verdict-ring relative z-[1] rounded-lg"
      animate={activeAnimate}
      transition={{
        duration: config.duration,
        // Green: spring-out (playful bounce). Red: easeInOut
        // (natural settle). Same keyframes read differently under
        // different easings — spring-out for green feels
        // celebratory, easeInOut for red feels calm.
        ease: isGreen ? [0.34, 1.4, 0.6, 1] : [0.42, 0, 0.58, 1],
      }}
    >
      {children}
      {reacted && particleCount > 0 && <ParticleBurst count={particleCount} />}
    </motion.div>
  );
}

/** ParticleBurst — emerald sparkles rising above the tile from
 *  the top-centre, with slight horizontal jitter and staggered
 *  emission. Purely decorative; rendered only during green tier
 *  reactions.
 *
 *  Positioning: absolute, anchored to top-centre of the parent
 *  motion.div (which is `relative`). `pointer-events-none` so
 *  the sparkles never intercept clicks. `-top-1` lifts them
 *  just above the tile's top edge.
 *
 *  Timing: each particle has a 35ms stagger so the burst reads
 *  as a small emission event, not a single flash. Total duration
 *  ~1.2s including the last particle's fade-out.
 *
 *  Randomised offsets memoized per mount — a re-render mid-flight
 *  would otherwise re-roll the x/y/duration values and cause
 *  particles to snap to new targets mid-arc. useMemo keyed on
 *  count freezes them for the lifetime of the burst; particles
 *  re-roll only if a new ParticleBurst is instantiated. */
function ParticleBurst({ count }: { count: number }) {
  const particles = useMemo(
    () =>
      Array.from({ length: count }).map(() => ({
        xOffset: (Math.random() - 0.5) * 54,
        yRise: -22 - Math.random() * 20,
        duration: 0.9 + Math.random() * 0.3,
      })),
    [count]
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 -top-1 flex justify-center">
      {particles.map((p, i) => (
        <motion.span
          key={i}
          className="absolute text-[9px] leading-none text-[hsl(var(--success))]"
          initial={{ opacity: 0, x: 0, y: 4, scale: 0.6 }}
          animate={{
            opacity: [0, 1, 0],
            x: p.xOffset,
            y: p.yRise,
            scale: [0.6, 1, 0.5],
          }}
          transition={{
            duration: p.duration,
            delay: i * 0.035,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          ✦
        </motion.span>
      ))}
    </div>
  );
}
