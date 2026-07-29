/**
 * lib/studio/skyCrackers.ts
 *
 * DORMANT AS OF 2026-07-25 — the canvas-confetti particle burst
 * described below was the M5 implementation of the Studio's success
 * moment. It has since been replaced by a full-viewport Lottie
 * confetti animation (see components/studio/CelebrationOverlay.tsx)
 * that plays in a dedicated 'celebrating' page stage between Submit
 * and the RevealDashboard.
 *
 * No consumer imports fireSkyCrackers / cancelSkyCrackers /
 * preloadSkyCrackers today; this file is kept intact for reference
 * and easy revival if we ever want a lightweight particle path
 * alongside or instead of the Lottie. The `canvas-confetti` dep in
 * package.json is likewise dormant — reinstate a `preloadSkyCrackers`
 * call and a `fireSkyCrackers` trigger to bring the whole thing back.
 *
 * Studio's success-burst particle system — the "sky-crackers" visual
 * that celebrates a submitted MF order on `/studio`. Fires ONLY on
 * the Submit path (never on Skip), pairs with the audio choreography
 * in RevealDashboard, and completes well before the stats cascade
 * begins so the particles don't fight the reveal for visual attention.
 *
 * Design brief (2026-07-24)
 * -------------------------
 * "Gold sparkles rising from below" — the vibe is Diwali sky-crackers,
 * not birthday-party confetti. Particles LAUNCH upward from just
 * above the bottom edge, arc through the top half of the viewport,
 * then fall back under gravity. Multi-burst pattern (center → left →
 * right → tail sprinkle) so it feels like a coordinated volley of
 * three crackers instead of one flat pop.
 *
 * Palette
 * -------
 * Five shades of gold — spans warm/deep gold to a pale sparkle
 * highlight. Deliberately narrow (no reds, no whites, no blues) to
 * lock in the "wealth" narrative of the 10K→100Cr experiment. Adding
 * more hues muddies the read on a phone screen where the whole
 * effect lasts ~2s.
 *
 * Why canvas-confetti
 * -------------------
 * We're rendering ~230 particles with physics (velocity, gravity,
 * rotation) across ~1s of firing. DOM + framer-motion at this
 * particle count means 230 layout-affecting nodes at 60fps, which
 * kills performance on mid-range phones. Canvas-confetti draws to a
 * single <canvas> element, positions it fixed, and does the physics
 * in one animation loop — 3KB gzipped, zero peer deps, battle-tested
 * (GitHub uses it for merge celebrations). We use its built-in
 * `disableForReducedMotion` too, so users who've set that OS
 * preference automatically skip the burst.
 *
 * Timing (relative to reveal-content mount, matches the audio doc
 * in RevealDashboard)
 * ---------------------------------------------------------------
 *   t=0    ─ Main center burst        (aligns with swoosh + chart draw start)
 *   t=180  ─ Left flank burst
 *   t=360  ─ Right flank burst
 *   t=800  ─ Tail sprinkle
 *
 * Particles live for `ticks=300` frames (~5s at 60fps but they've
 * already fallen off-screen by ~2.5s under gravity=1.0), well clear
 * of the STATS_BASE=2750ms cascade so the two effects don't collide.
 *
 * SSR safety
 * ----------
 * The canvas-confetti module touches `document` at import time to
 * create its default canvas. It's loaded via dynamic import to keep
 * SSR safe AND to defer the ~3KB bundle cost until the first fire
 * (which only happens after the user submits — so the entry-form
 * initial paint doesn't carry it).
 */

// ── Types ────────────────────────────────────────────────────────

// canvas-confetti's @types package uses `export = confetti` (CJS-style
// default), so at the type level `typeof import("canvas-confetti")`
// IS the function directly — there's no `.default` member in the
// namespace type. At runtime with esModuleInterop the dynamic import
// exposes both the function itself AND a `default` property pointing
// at the same function, which is why the getConfetti() helper below
// reads `m.default` — that access is safe at runtime, we just can't
// spell it in the type.
type ConfettiFn = typeof import("canvas-confetti");

// ── Palette ──────────────────────────────────────────────────────

/** Five shades of gold — deliberately unified. Pure gold plus deep
 *  gold plus amber for warmth plus pale gold plus a bright highlight
 *  for the "spark" contrast. Any confetti call that uses this array
 *  picks colours randomly from it. */
const GOLD_PALETTE: string[] = [
  "#FFD700", // pure gold
  "#FFC300", // deep gold
  "#F9A825", // amber
  "#FFB300", // burnt gold
  "#FFECB3", // pale highlight
];

// ── Module-level cache ───────────────────────────────────────────

/** Lazy-loaded confetti module. First fire triggers the dynamic
 *  import; every subsequent fire reuses the cached promise. We cache
 *  the PROMISE (not the resolved function) so parallel first-fires
 *  don't kick off duplicate module loads. */
let confettiPromise: Promise<ConfettiFn> | null = null;

async function getConfetti(): Promise<ConfettiFn> {
  if (!confettiPromise) {
    confettiPromise = import("canvas-confetti").then((m) => {
      // esModuleInterop / bundler CJS handling can surface the function
      // either directly on the namespace (matching the `export =` type)
      // or wrapped under `.default`. Prefer `.default` when present
      // (dev / Next.js bundler wraps it that way) and fall back to the
      // namespace itself for stricter interop modes.
      const mod = m as unknown as ConfettiFn & { default?: ConfettiFn };
      return mod.default ?? mod;
    });
  }
  return confettiPromise;
}

// ── Reduced-motion / SSR guard ──────────────────────────────────

/** Skip the burst when:
 *   • Running on the server (no window)
 *   • User has prefers-reduced-motion: reduce set at the OS level
 *  Mirrors the same helper in lib/studio/sounds.ts so audio and
 *  visuals stay consistent — if you can't hear the ding, you also
 *  don't get the visual pop. */
function shouldFire(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

// ── Burst recipes ────────────────────────────────────────────────

/** The centre-stage main burst. Fires straight up from just above the
 *  bottom edge, wide spread, high particle count. This is the beat
 *  the user actually SEES — the flanks and tail are garnish. */
const MAIN_BURST: import("canvas-confetti").Options = {
  particleCount: 80,
  angle: 90,
  spread: 70,
  startVelocity: 62,
  gravity: 1.0,
  ticks: 300,
  scalar: 1.1,
  shapes: ["star", "circle"],
  colors: GOLD_PALETTE,
  origin: { x: 0.5, y: 0.9 },
  zIndex: 200,
  // Belt-and-braces: canvas-confetti also honours the OS preference
  // internally. shouldFire() gives us an early return before we even
  // load the module, so most users with reduced-motion never pay the
  // bundle cost; this option catches anyone who slips through.
  disableForReducedMotion: true,
};

/** Left-flank follow-up. Angled slightly right of vertical so its
 *  arc crosses the centre burst's tail — gives the illusion of a
 *  second cracker fired from the left curb. */
const LEFT_BURST: import("canvas-confetti").Options = {
  particleCount: 60,
  angle: 75, // Slight lean toward vertical, launches up-right
  spread: 55,
  startVelocity: 55,
  gravity: 1.0,
  ticks: 280,
  scalar: 1.0,
  shapes: ["star", "circle"],
  colors: GOLD_PALETTE,
  origin: { x: 0.2, y: 0.9 },
  zIndex: 200,
  disableForReducedMotion: true,
};

/** Right-flank follow-up. Mirror of LEFT_BURST — angle 105° means
 *  slight lean toward vertical from the right side, so its arc
 *  crosses the centre burst's tail from the opposite direction. */
const RIGHT_BURST: import("canvas-confetti").Options = {
  particleCount: 60,
  angle: 105,
  spread: 55,
  startVelocity: 55,
  gravity: 1.0,
  ticks: 280,
  scalar: 1.0,
  shapes: ["star", "circle"],
  colors: GOLD_PALETTE,
  origin: { x: 0.8, y: 0.9 },
  zIndex: 200,
  disableForReducedMotion: true,
};

/** Tail sprinkle — small, high-velocity burst 800ms after main. Fires
 *  smaller particles (scalar 0.8) so it reads as "settling dust" or
 *  "trailing sparks" rather than a fourth cracker. Wide spread so
 *  the sparkles feather out across the whole screen. */
const TAIL_SPRINKLE: import("canvas-confetti").Options = {
  particleCount: 30,
  angle: 90,
  spread: 120,
  startVelocity: 40,
  gravity: 0.9,
  ticks: 260,
  scalar: 0.8,
  shapes: ["star"],
  colors: GOLD_PALETTE,
  origin: { x: 0.5, y: 0.85 },
  zIndex: 200,
  disableForReducedMotion: true,
};

// ── Public API ───────────────────────────────────────────────────

/** Fire the full multi-burst sky-crackers sequence. Non-blocking:
 *  returns immediately, bursts are scheduled via setTimeout and play
 *  out over the next ~1s. Total visual effect lasts ~2-2.5s including
 *  particle fall time.
 *
 *  Timeout IDs are collected and returned so the caller can cancel a
 *  pending sequence if the reveal unmounts mid-burst (e.g., user hits
 *  Back before all bursts have fired). Cancelling clears any
 *  scheduled-but-not-yet-fired bursts; particles already in flight
 *  fall out naturally under gravity — no need to hard-reset the
 *  canvas.
 *
 *  Returns: an array of timeout IDs that can be passed to
 *  cancelSkyCrackers(). Empty array when the burst is skipped
 *  (SSR / reduced motion). */
export function fireSkyCrackers(): number[] {
  if (!shouldFire()) return [];

  const timeouts: number[] = [];

  // Kick the dynamic import immediately so it's warm by the time
  // the first burst fires. The center burst runs synchronously
  // in the microtask following module load.
  void getConfetti().then((confetti) => {
    confetti(MAIN_BURST);
  });

  timeouts.push(
    window.setTimeout(() => {
      void getConfetti().then((confetti) => confetti(LEFT_BURST));
    }, 180)
  );

  timeouts.push(
    window.setTimeout(() => {
      void getConfetti().then((confetti) => confetti(RIGHT_BURST));
    }, 360)
  );

  timeouts.push(
    window.setTimeout(() => {
      void getConfetti().then((confetti) => confetti(TAIL_SPRINKLE));
    }, 800)
  );

  return timeouts;
}

/** Cancel any pending burst timeouts. Safe to call with an empty
 *  array (no-op). Particles already rendered continue to fall
 *  naturally — this only stops future bursts from firing. */
export function cancelSkyCrackers(timeouts: number[]): void {
  for (const id of timeouts) window.clearTimeout(id);
}

/** Optionally warm the module load before the first fire. Call this
 *  from OrderEntryLanding when the user is about to submit (e.g., on
 *  form focus) so the ~3KB module is already in memory by the time
 *  Submit is tapped and the reveal mounts. Safe to call from SSR
 *  contexts — the dynamic import is client-only anyway, but the
 *  wrapper checks `typeof window` to avoid noisy build warnings. */
export function preloadSkyCrackers(): void {
  if (typeof window === "undefined") return;
  void getConfetti();
}
