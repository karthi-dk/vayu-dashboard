"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { OrderEntryLanding } from "@/components/studio/OrderEntryLanding";
import { RevealDashboard } from "@/components/studio/RevealDashboard";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import { getStudioData, type StudioData } from "@/app/studio/data";

/**
 * /studio — the daily recording landing surface for the 10K→100Cr
 * experiment videos.
 *
 * State machine
 * -------------
 *   'entry'        → OrderEntryLanding (form)
 *   'celebrating'  → CelebrationOverlay (Lottie confetti burst, 2.67s)
 *   'reveal'       → RevealDashboard (chart + progress + stats)
 *
 * Transitions:
 *
 *   • Submit success  → 'entry' → 'celebrating' → 'reveal'
 *                        (Lottie plays, then chart ceremony fires)
 *   • Skip button     → 'entry' → 'reveal' (bypasses celebrating,
 *                        wasSubmit=false → silent load)
 *
 * Why a dedicated celebrating stage
 * ---------------------------------
 * The success burst is the video-recording money shot — a proud
 * confetti moment BEFORE the numbers reveal. Overlapping the burst
 * with the chart draw (as an earlier iteration did with canvas-
 * confetti particles) split attention: you either watched the
 * chart or the particles, never both. Making it sequential means:
 *
 *   1. Submit taps → click sound
 *   2. Server-action round-trip (~500ms-1s) — meanwhile the Lottie
 *      JSON + lottie-react code split loads in the background.
 *   3. CelebrationOverlay mounts → sky-cracker sfx + Lottie plays
 *      for 2.67s of undivided attention. This is the beat the
 *      user posts to the video.
 *   4. Lottie completes → RevealDashboard mounts → swoosh + chart
 *      draw + pill ding + roll-ups fire in their own choreography.
 *
 * Total flow: ~2.67s celebrate + ~4s reveal = ~6-7s from Submit to
 * settled. Long for a normal app, tight for a recording surface
 * with the double payoff of burst + chart-draw ceremony.
 *
 * Dynamic import of CelebrationOverlay
 * ------------------------------------
 * `lottie-react` (via `lottie-web`) touches `document` at module
 * load, and the Lottie JSON adds ~127KB to whichever bundle it's
 * imported into. Both concerns are handled by importing the
 * component via `next/dynamic` with `ssr: false`:
 *
 *   • SSR skips the module entirely — no `document` on the server.
 *   • The component + its lottie-react dep + the JSON all land in
 *     a separate chunk that's fetched only after Submit fires and
 *     the celebrating stage transitions in.
 *
 * Client-only page
 * ----------------
 * Marked "use client" because the whole page is stateful and driven
 * by user interaction. There's no server-rendered content on /studio
 * that a search bot or unauth visitor would care about (middleware
 * gates the route anyway).
 */

const CelebrationOverlay = dynamic(
  () => import("@/components/studio/CelebrationOverlay"),
  {
    ssr: false,
    // Loading placeholder — a blank neutral canvas so the transition
    // from entry → celebrating doesn't flash a white page while the
    // chunk resolves. In practice the chunk is usually already
    // warm (server-action round-trip covered its load), so the
    // loading state renders for maybe 1-2 frames at most.
    loading: () => <div className="min-h-dvh w-full bg-background" />,
  }
);

type Stage = "entry" | "celebrating" | "reveal";

export default function StudioPage() {
  const [stage, setStage] = useState<Stage>("entry");
  // Distinguishes the two paths into 'reveal': submit-with-Lottie
  // versus skip-without. RevealDashboard's `wasSubmit` prop drives
  // its animation gating.
  const [enteredViaSubmit, setEnteredViaSubmit] = useState<boolean>(false);
  // Bumped every time we enter the reveal state via a successful
  // submit. RevealDashboard depends on this key in its data-fetch
  // effect, so a fresh submit triggers a re-fetch and the "This
  // Month Orders" and "Total Orders" tiles pick up the just-logged
  // row's contribution. Skip doesn't bump it — no new data.
  const [refreshKey, setRefreshKey] = useState<number>(0);
  // Preloaded StudioData from the celebrating stage. RevealDashboard
  // seeds its own state from this on mount, which lets us skip the
  // ~300-800ms of "data === null" post-mount fetch that would
  // otherwise render the LoadingSkeleton flash between the Lottie
  // burst and the chart draw. See the useEffect below for the
  // preload trigger + timing rationale.
  const [preloadedData, setPreloadedData] = useState<StudioData | null>(null);

  // Preload trigger — kicks off getStudioData() when we enter the
  // celebrating stage (submit path) so the ~500ms server round-trip
  // finishes DURING the 2.5s Lottie burst rather than after it. By
  // the time onDone advances stage → 'reveal', preloadedData is
  // already populated, RevealDashboard seeds its state from it, and
  // the skeleton branch is never rendered.
  //
  // Reset to null on the 'entry' transition (Back button, Skip
  // reset, first mount) so the next celebration re-fetches. Skip
  // path (entry → reveal without celebrating) doesn't preload —
  // RevealDashboard falls back to its mount-time fetch and the
  // skeleton flashes briefly. Acceptable trade-off since Skip is
  // meant to be a silent bypass, not the video-recording path.
  useEffect(() => {
    if (stage === "entry") {
      setPreloadedData(null);
      return;
    }
    if (stage !== "celebrating") return;
    let cancelled = false;
    getStudioData()
      .then((payload) => {
        if (!cancelled) setPreloadedData(payload);
      })
      .catch(() => {
        // Silent failure — RevealDashboard will retry the fetch
        // on its own useEffect if we hand it null.
      });
    return () => {
      cancelled = true;
    };
  }, [stage]);

  return (
    // min-h-dvh (dynamic viewport height) so on mobile browsers the
    // page fills the visible area WITHOUT double-counting the
    // dynamic browser chrome (URL bar collapsing/expanding on scroll).
    // 100vh would leave a stripe at the bottom on iOS Safari when the
    // URL bar is expanded. Since we hide TopNav on /studio there's no
    // 56px chrome to subtract — the layout owns the full viewport.
    <div className="min-h-dvh">
      {/* Global click-sound listener — mounts once for the whole
          /studio route. Plays the tactile tap on every button /
          dropdown / date-picker commit and Submit / Skip / Back /
          Replay. Renders nothing. */}
      <StudioClickSound />
      {/* Visual counterpart — flashes a ring at the tap point on
          every interactive gesture, so taps read clearly in video
          screen recording (where OS "show touches" isn't captured
          by default). Fires on pointerdown for immediate feedback,
          same target filter as StudioClickSound. Renders nothing. */}
      <StudioClickPulse />
      {stage === "entry" && (
        <OrderEntryLanding
          onSubmitted={() => {
            setEnteredViaSubmit(true);
            setRefreshKey((k) => k + 1);
            // Route through celebrating first — the Lottie plays, then
            // onDone advances us to reveal. RevealDashboard mounts
            // AFTER the confetti burst finishes.
            setStage("celebrating");
          }}
          onSkipped={() => {
            setEnteredViaSubmit(false);
            // Skip path bypasses celebrating — no Lottie, no cracker
            // sound, straight to the (silent) reveal.
            setStage("reveal");
          }}
        />
      )}
      {stage === "celebrating" && (
        <CelebrationOverlay
          onDone={() => setStage("reveal")}
        />
      )}
      {stage === "reveal" && (
        <RevealDashboard
          wasSubmit={enteredViaSubmit}
          onReset={() => {
            setStage("entry");
            setEnteredViaSubmit(false);
          }}
          refreshKey={refreshKey}
          initialData={preloadedData}
          studioTheme="classic"
        />
      )}
    </div>
  );
}
