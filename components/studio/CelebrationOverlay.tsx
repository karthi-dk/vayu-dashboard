"use client";

import { useEffect, useRef } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import successConfetti from "@/lib/studio/animations/success_confetti.json";
import { playCracker } from "@/lib/studio/sounds";

/**
 * CelebrationOverlay — the 2.67-second confetti burst that plays
 * between a successful order submit and the reveal dashboard.
 *
 * Flow
 * ----
 *   Submit → server action succeeds → page transitions to
 *   'celebrating' stage → this component mounts → Lottie plays to
 *   completion → onComplete callback advances the page to 'reveal'.
 *
 * Skip semantics
 * --------------
 * The user's Skip button on the entry form bypasses this stage
 * entirely (page.tsx routes it straight to 'reveal' with
 * wasSubmit=false). So this component only ever mounts on the
 * happy path; it has no skip button of its own.
 *
 * Design notes
 * ------------
 * • The Lottie is 1400×1400, so we render it with `object-fit: contain`
 *   inside a full-viewport container. The animation is centred both
 *   horizontally and vertically to keep its focal point (streamer
 *   emission origin) in the middle of the screen regardless of
 *   aspect ratio.
 *
 * • Sound: we fire the user's selected sky-cracker variant EXACTLY
 *   ONCE at mount, alongside the Lottie's first frame. The synth
 *   durations (400-2000ms) all fit comfortably inside the 2670ms
 *   Lottie window with headroom before the reveal takes over.
 *
 * • lottie-react wraps lottie-web, which touches `document` at
 *   module load. This component is imported via `next/dynamic` with
 *   `ssr: false` at the page level so the whole subtree stays out
 *   of the SSR pass. That also keeps ~250KB of player + animation
 *   JSON out of the entry-form initial bundle — everything loads
 *   during the ~500ms-1s of server-action round-trip after Submit.
 *
 * • The Lottie is set to non-looping (`loop={false}`); when it
 *   reaches the last frame, `onComplete` fires exactly once and
 *   we call `onDone()` to advance the stage.
 *
 * • Belt-and-braces auto-advance: we also set a fallback timeout
 *   at ~2800ms (Lottie duration + 130ms buffer). If `onComplete`
 *   somehow doesn't fire — animation error, browser tab throttled
 *   in the background, Lottie library edge case — the user is
 *   never left staring at a stalled confetti burst.
 */

/** Native duration of the Lottie file — 160 frames at 60fps =
 *  2666.67ms. This is what the animation plays for at speed=1. */
const LOTTIE_NATIVE_DURATION_MS = 2670;

/** Desired total playback duration in ms. Tunable knob for the
 *  celebration beat's length. User tuning 2026-07-25: retuned
 *  from 2670 (native) → 1200 → 1600 → 2000 → 2500. Now every
 *  cracker variant (max 2000ms for Sparkler Sizzle) completes
 *  with 500ms of visual settling headroom before the reveal
 *  takes over. The Lottie is sped up via `speed` prop to
 *  compensate — every visual element (cannon fire, streamer
 *  unfurl, gravity fall) plays 1.068× faster (barely
 *  perceptible, but the ~170ms saved feels sharper on tap). */
const LOTTIE_DURATION_MS = 2500;

/** Playback speed multiplier passed to lottie-react. Derived
 *  from the ratio of native to desired duration so this stays
 *  correctly in sync if either constant is retuned. At the
 *  current 1200ms/2670ms setting = ~2.225x. */
const LOTTIE_SPEED = LOTTIE_NATIVE_DURATION_MS / LOTTIE_DURATION_MS;

/** Buffer between the Lottie's expected end and the fallback
 *  timeout, in case the internal onComplete callback is delayed
 *  by rAF timing or a stalled frame. Small enough that the user
 *  doesn't perceive a stall even if the fallback fires. */
const FALLBACK_BUFFER_MS = 130;

export default function CelebrationOverlay({ onDone }: { onDone: () => void }) {
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const advancedRef = useRef<boolean>(false);

  // Guard against double-advance: onComplete AND the fallback timer
  // can race, so we lock the transition to a single call. This
  // matters most on very slow devices where the fallback might beat
  // Lottie's own completion signal by a few ms.
  const advance = () => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    onDone();
  };

  useEffect(() => {
    // Fire the user's chosen cracker sound in lockstep with the
    // Lottie's first frame. playCracker() is idempotent and
    // reads the active variant from localStorage — the user can
    // change their pick on /studio/sounds and the next celebration
    // hears the new one immediately.
    playCracker();

    // Apply the speed multiplier via the imperative ref API.
    // The `speed` prop was removed from lottie-react in a later
    // version, but setSpeed() on the ref is preserved and behaves
    // identically — scales all frame deltas so every internal
    // keyframe interpolation runs proportionally faster. This is
    // preferable to trimming frames (initialSegment) because it
    // preserves the full choreography (cannon fire → streamer
    // unfurl → gravity fall) — the animation just finishes sooner.
    lottieRef.current?.setSpeed(LOTTIE_SPEED);

    // Fallback auto-advance — see FALLBACK_BUFFER_MS docs above.
    const fallbackId = window.setTimeout(
      advance,
      LOTTIE_DURATION_MS + FALLBACK_BUFFER_MS
    );
    return () => window.clearTimeout(fallbackId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Full-viewport FIXED overlay. Uses `fixed inset-0` (not
    // `min-h-dvh` in-flow) so the celebration is centered on the
    // ACTUAL visible viewport, not centered inside the residual
    // space after siblings like TestModeBanner. Earlier iteration
    // used min-h-dvh which pushed the Lottie down by the banner's
    // ~60px, breaking vertical centering.
    //
    // z-40 keeps the overlay ABOVE the TestModeBanner (default z=0)
    // and any other stage chrome, but BELOW the click-pulse ring
    // (z-9999 in globals.css) so tap-feedback rings still render
    // on top of the animation for anyone tapping during the burst.
    // bg-background gives the Lottie a neutral canvas that matches
    // the rest of /studio.
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background">
      <div className="relative aspect-square w-full max-w-[min(90dvh,90vw)]">
        {/* The Lottie itself. autoplay=true, loop=false, and onComplete
            wires the advance. animationData is inline-bundled via
            next.js's JSON import — dynamic-import at the page level
            ensures the 127KB JSON is code-split into its own chunk. */}
        <Lottie
          lottieRef={lottieRef}
          animationData={successConfetti}
          loop={false}
          autoplay
          onComplete={advance}
          // Playback speed is applied via lottieRef.current.setSpeed
          // in the useEffect above (LOTTIE_SPEED). See the effect
          // comment for why the imperative API is used instead of a
          // JSX prop.
          rendererSettings={{
            // preserveAspectRatio 'xMidYMid meet' centres the animation
            // and scales it to fit — same behaviour as CSS
            // object-fit: contain. This matches our aspect-square
            // wrapper, so the animation always fills its box.
            preserveAspectRatio: "xMidYMid meet",
          }}
          className="h-full w-full"
        />
      </div>
    </div>
  );
}
