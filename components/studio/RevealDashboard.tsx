"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { GrowthChart } from "@/components/studio/GrowthChart";
import { StatsRow } from "@/components/studio/StatsRow";
import { getStudioData, type StudioData } from "@/app/studio/data";
import {
  playDing,
  playRollupForReveal,
  playSwoosh,
  playVerdict,
} from "@/lib/studio/sounds";

/**
 * RevealDashboard — the post-submit / post-skip state of /studio.
 *
 * Composition (top → bottom):
 *   1. Header (Studio title + Back button)   — 0–300ms
 *   2. Growth chart line-draw                — 100–1600ms
 *   3. Current-value pill + roll-up          — 1400–2400ms
 *   4. Daily progress cells (4-way stagger)  — 1700–2500ms
 *   5. Stats row cells (4-way stagger)       — 2200–3400ms
 *
 * Total budget ≈ 3.5s (matches the /studio briefing).
 *
 * Animate vs skip
 * ---------------
 * `shouldAnimate` toggles the whole ceremony:
 *   • true  (Submit success) — full 3.5s sequence, roll-up counters,
 *                                staggered cell entrances.
 *   • false (Skip)           — instant render, numbers appear at
 *                                their final values. Chart still
 *                                draws statically (no left-to-right
 *                                sweep).
 * Users with prefers-reduced-motion get the Skip path automatically
 * via the RollUpNumber primitive; motion.div respects the same
 * MediaQuery through framer-motion's built-in support.
 *
 * Data flow
 * ---------
 * • Fetches `getStudioData()` on mount and whenever `refreshKey`
 *   changes. Parent bumps refreshKey on a successful submit so the
 *   ledger's "today count" reflects the freshly-logged row.
 * • Loading state shows a skeleton — no jitter, no spinner.
 *
 * Back button
 * -----------
 * Small "Back" affordance in the top-right returns to the order-
 * entry form. Useful during testing / rehearsals when you want to
 * loop through the flow multiple times without a page reload.
 */

/**
 * Chart height — kept as a shared constant so GrowthChart's canvas,
 * its no-data fallback, and the loading skeleton all stay in lockstep.
 *
 *   • Value: 33dvh (about a third of the visible viewport) — user
 *     tuning 2026-07-25, replacing the fixed 440px height that felt
 *     too tall on portrait phones and pushed the daily-progress
 *     row below the fold.
 *   • Units: dvh (dynamic viewport height) not vh — dvh accounts
 *     for the mobile URL-bar collapsing on scroll, so the chart
 *     doesn't jump size when the browser chrome auto-hides. Same
 *     unit family used by the min-h-dvh on the /studio page shell.
 *
 * Change the class here to resize every chart-shaped surface at once.
 */
export const STUDIO_CHART_HEIGHT_CLASS = "h-[33dvh]";

/** Shared choreography timing (ms) — every child component receives
 *  these via props so the sequence stays in lockstep. Tune here,
 *  never inline in a component.
 *
 *  TOTAL BUDGET: 4s (2026-07-25 tuning — was 5.5s briefly, which
 *  felt luxurious for one-off admiration but too slow for daily
 *  recording where the tester watches this dozens of times per
 *  session. 4s hits the sweet spot: chart sweep is still readable
 *  as a "draw", but the sequence completes fast enough to not
 *  interrupt the shot rhythm).
 *
 *  Waterfall (t=0 = GrowthChart / StatsRow mount, which happens
 *  after the reveal-content fade-in resolves):
 *
 *    t=0    ─ Chart line-draw begins (both value area and invested
 *              line sweep left-to-right)
 *    t=1700 ─ Chart draw complete
 *    t=1600 ─ Pill fades in + value/gain/next-milestone roll up
 *              (starts 100ms BEFORE chart finishes so the pill lands
 *               with the final peak of the curve — coordinated arrival)
 *    t=2000 ─ Slot-machine rollup sound fires (2030ms duration →
 *              jackpot ding at ~4030 to coincide with the last
 *              rolling stats tile settling)
 *    t=2580 ─ Stats grid cells begin cascading in (100ms stagger,
 *              6 tiles: 1 Day, Total Invested, Daily Earning,
 *              Avg Order Size, Profit per Order, Total Orders)
 *    t=2600 ─ Pill roll-up complete (20ms overlap with stats
 *              cascade start — different visual regions, no clash)
 *    t=3080 ─ Last cell (Total Orders, idx 5) fades in and starts
 *              rolling
 *    t=4030 ─ Total Orders roll-up settles → audio jackpot ding
 *              lands at the same instant
 *    t=4530 ─ Ding's G6 note (500ms decay tail) fully silences
 *    t=5500 ─ 1D verdict coda fires (sign+magnitude-tiered): visual
 *              pulse/settle/tilt on the 1D tile + short musical
 *              stinger (major chime on green, soft descend on red,
 *              silent on flat). 970ms of silence between ding-tail
 *              end and verdict onset — reads as a clean separator
 *              between "reveal climax" and "app's verdict lands"
 *              beats, not a muddy overlapping chord.
 *              → curtain
 *
 *  History (STATS_BASE / STATS_STAGGER):
 *    • 2750 / 110 — original 4-cell (Value, Invested, Gain, XIRR)
 *    • 2860 / 110 — briefly, when XIRR was dropped and the row
 *                   shrank to 3 cells
 *    • 2750 / 110 — 1D tile filled the fourth slot
 *    • 2750 / 110 — 6-cell BEST TODAY / PEAK DAY layout
 *    • 2600 / 100 — DailyProgressCard collapsed into the stats
 *                   grid (this-month + total order counts moved in,
 *                   dropped 30D/BEST/PEAK)
 *    • 2780 / 150 — TOTAL GAIN dropped, ORDERS tiles merged, grid
 *                   shrank 6 → 4. Stagger widened (100 → 150) to
 *                   preserve the paced cascade rhythm at a smaller
 *                   tile count.
 *    • 2580 / 100 — current: grid re-expanded back to 6 by adding
 *                   DAILY EARNING, AVG ORDER SIZE, PROFIT PER ORDER
 *                   from the shortlist. Stagger returned to 100
 *                   (six tiles at 150ms would push the cascade
 *                   past 5s and desync the audio). STATS_BASE
 *                   nudged 20ms earlier (2600 → 2580) so the last
 *                   rolling cell (index 5) still lands at exactly
 *                   4030 for millisecond-perfect audio sync.
 */
export const STUDIO_TIMING = {
  HEADER_MS: 300,
  CHART_DURATION: 1700,
  PILL_BEGIN: 1600,
  PILL_DURATION: 1000,
  /** When the slot-machine rollup sound fires. Named for its role,
   *  not the visual it accompanies — historically this was the
   *  progress-card cascade start, but that card was removed on
   *  2026-07-28 and the constant now serves only as the audio
   *  cue timing. Kept at 2000 so the sound's 2030ms body ends at
   *  ~4030, matching when the last stats tile finishes rolling. */
  ROLLUP_SOUND_BEGIN: 2000,
  STATS_BASE: 2580,
  STATS_STAGGER: 100,
  STATS_ROLLUP: 950,
  /** When Total Orders (stats tile idx 5) finishes rolling.
   *  = STATS_BASE + 5*STATS_STAGGER + STATS_ROLLUP.
   *  Counter ASMR + its single ending beep land here. */
  TOTAL_ORDERS_SETTLE: 2580 + 5 * 100 + 950, // 4030
  /** 1D verdict coda offset from t=0. Sign+magnitude-tiered sound
   *  & visual: chime up on green, soft descend on red, silent on
   *  flat. Both StatsRow (visual pulse/settle/tilt + particles)
   *  and RevealDashboard (playVerdict sound trigger) read from
   *  this same constant so the audiovisual pair stays sample-
   *  accurate. Keep in sync with the last rolling tile: if
   *  STATS_ROLLUP or the tile count changes, adjust here to
   *  preserve the ~970ms silence buffer described below.
   *
   *  Timing math (2026-07-29 tuning — pushed from 4280 to 5500
   *  after user reported the verdict overlapping the rollup
   *  ding's decay tail):
   *
   *    Last stats tile settles: STATS_BASE + 5*STATS_STAGGER +
   *                             STATS_ROLLUP = 4030
   *    Jackpot ding fires:      4030 (same instant, from
   *                             synthSlotMachine)
   *    Ding G6 note decay:      500ms → ding fully silences at
   *                             ~4530
   *    Verdict fires:           5500  → 970ms of clean silence
   *                                     between ding decay end
   *                                     and verdict onset. That
   *                                     ~1s pause reads as
   *                                     "reveal complete → app's
   *                                     verdict lands" instead of
   *                                     two overlapping sounds.
   *
   *  Prior value (4280 = 250ms after last tile) landed the
   *  verdict smack in the middle of the ding's 500ms decay tail,
   *  producing a muddy chord instead of two distinct beats.
   *  The user flagged this immediately on first playback. */
  VERDICT_BEGIN: 5500,
} as const;

/** TEMP: Replay shown in prod for screen-recording / choreography
 *  checks. Flip to `false` (or delete the button block) when done —
 *  it was originally `NODE_ENV === "development"` only. */
const SHOW_STUDIO_REPLAY = true;

export function RevealDashboard({
  wasSubmit,
  onReset,
  refreshKey = 0,
  initialData = null,
}: {
  wasSubmit: boolean;
  onReset: () => void;
  /** Bumping this triggers a re-fetch. Parent increments it after a
   *  submit so the dashboard shows the just-logged row's contribution
   *  in the "This Month Orders" and "Total Orders" tiles. */
  refreshKey?: number;
  /** Pre-fetched studio data — passed by the page shell after
   *  preloading during the celebrating stage. When present, we
   *  skip the mount-time fetch entirely so the reveal renders
   *  with real content on the first paint (no skeleton flash).
   *
   *  If null / undefined (Skip path with no celebration to hide
   *  the fetch behind, or first mount before parent hooks the
   *  preload), we fall back to the classic mount-time fetch and
   *  the LoadingSkeleton renders briefly. */
  initialData?: StudioData | null;
}) {
  // Seed with preloaded data if provided — this is what removes
  // the skeleton flash. When the parent has already fetched during
  // the celebrating stage, `data` is populated at mount and the
  // <LoadingSkeleton /> branch never renders.
  const [data, setData] = useState<StudioData | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  // Track the refreshKey we mounted with so we can distinguish
  // "mount-time fetch" (skip if we have initialData) from a
  // later refetch triggered by the parent bumping refreshKey
  // (always execute — the parent explicitly asked for fresh data).
  const initialRefreshKeyRef = useRef<number>(refreshKey);
  // Replay counter — incrementing this changes the `key` on the
  // animated content wrapper, forcing framer-motion to unmount and
  // remount the whole subtree. That's what re-fires the entrance
  // sequence: chart line-draw + pill fade + roll-ups + cell
  // staggers all restart from t=0 without needing a form round-trip.
  // Gated by SHOW_STUDIO_REPLAY (temp-on for recording).
  const [replayCount, setReplayCount] = useState<number>(0);
  // Submit path = animate. Skip path = static. Once data has landed
  // for the first time in a submit session, subsequent refreshes
  // don't re-animate — that would look wrong (numbers "rewinding"
  // to zero and rolling up again on every tab-focus refresh).
  // Replay overrides this to force-animate.
  const shouldAnimate = wasSubmit || replayCount > 0;

  useEffect(() => {
    // Mount-time optimisation: if the parent preloaded data during
    // the celebrating stage (initialData was truthy at mount) AND
    // refreshKey is still at its original value (i.e. the parent
    // hasn't asked for a refresh since), skip the fetch entirely.
    // The seeded state IS the current data. Any later refreshKey
    // bump will fall through this guard and re-fetch normally.
    if (
      initialData != null &&
      refreshKey === initialRefreshKeyRef.current &&
      data != null
    ) {
      return;
    }
    let cancelled = false;
    setError(null);
    getStudioData()
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load Studio data"
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // AUDIO CHOREOGRAPHY (swoosh + ding + rollup).
  //
  // The 'click' sound already fired at Submit tap inside
  // OrderEntryLanding, and the sky-cracker sound + Lottie confetti
  // burst have already played out in the 'celebrating' stage
  // BEFORE this component mounts. That gesture chain also warmed
  // up the AudioContext, so by the time this effect runs the
  // context is guaranteed to be "running" (or silently ignored on
  // browsers without Web Audio).
  //
  // Timing (relative to reveal-content mount, which is now ~2.67s
  // AFTER the user tapped Submit thanks to the celebrating stage):
  //   • swoosh @ t=0     → aligns with chart line-draw start.
  //                        Called synchronously so it fires in the
  //                        same frame as GrowthChart's entrance
  //                        sweep begins. Swoosh duration is tuned
  //                        to CHART_DURATION so it decays as the
  //                        curve finishes drawing.
  //   • ding   @ t=1600  → aligns with STUDIO_TIMING.PILL_BEGIN —
  //                        the instant the current-value pill
  //                        scale-fades in over the chart.
  //   • rollup @ t=2000  → STUDIO_TIMING.ROLLUP_SOUND_BEGIN. Always
  //                        slot_machine via playRollupForReveal (lab
  //                        variant is ignored) so the 2030ms body
  //                        ends exactly when Total Orders (idx 5)
  //                        settles at TOTAL_ORDERS_SETTLE=4030. The
  //                        synth's jackpot G6 is the single ending
  //                        beep — no follow-up playDing (that used
  //                        to fire +500ms and sounded like a second,
  //                        mismatched tone).
  //   • verdict@ t=5500  → STUDIO_TIMING.VERDICT_BEGIN. Sign+
  //                        magnitude-tiered coda: chime up on green,
  //                        soft descend on red, silent on flat (see
  //                        resolveVerdictTier). Fires after the
  //                        jackpot ding's decay has cleared (~4530).
  //
  // WHY ROLLUP FIRES BEFORE THE CASCADE
  // ───────────────────────────────────
  // Historically rollup fired at the cascade start; when the
  // DailyProgressCard existed it also filled the 2000-2750 window
  // with visual motion. Removing that card left 600ms of "sound
  // playing over static UI" if rollup had stayed pinned to the
  // stats-cascade start. Solved by keeping the sound trigger at
  // 2000 and shifting the stats cascade earlier (STATS_BASE=2600):
  // sound now leads the cascade, tiles roll during its middle
  // section, and the sound's finale lands with the last tile —
  // net effect is a single seamless "spin → jackpot" cue rather
  // than two disjoint audio+visual moments.
  //
  // The dep on replayCount makes the dev "Replay" button re-fire
  // the whole reveal-audio sequence every time it's tapped. Note
  // that Replay does NOT re-fire the celebration Lottie — that
  // owns its own stage upstream, and this component is only ever
  // mounted downstream of it (or on skip, when it plays silently).
  //
  // Guard: only animate on Submit or Replay paths. Skip = silent.
  // Cleanup cancels all pending timeouts on unmount / re-fire so
  // we don't get orphan sounds if the user hits Back mid-animation.
  useEffect(() => {
    if (!shouldAnimate || data == null) return;
    playSwoosh();
    const dingId = window.setTimeout(playDing, STUDIO_TIMING.PILL_BEGIN);
    const rollupId = window.setTimeout(
      playRollupForReveal,
      STUDIO_TIMING.ROLLUP_SOUND_BEGIN
    );
    // Capture the 1D snapshot values at effect-run time so the
    // verdict fires with the numbers the user is watching settle,
    // even if `data` mutates later (e.g., a refetch during the
    // 4.3s reveal — unlikely, but the capture makes it correct
    // by construction).
    const oneDayInr = data.stats.oneDayInr;
    const oneDayPct = data.stats.oneDayPct;
    const verdictId = window.setTimeout(
      () => playVerdict(oneDayInr, oneDayPct),
      STUDIO_TIMING.VERDICT_BEGIN
    );
    return () => {
      window.clearTimeout(dingId);
      window.clearTimeout(rollupId);
      window.clearTimeout(verdictId);
    };
  }, [data, shouldAnimate, replayCount]);

  return (
    <div className="flex flex-col gap-4 pb-8">
      {/* Header — fades in at t=0, 300ms duration. Studio title + Back. */}
      <motion.header
        initial={shouldAnimate ? { opacity: 0, y: -8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: STUDIO_TIMING.HEADER_MS / 1000 }}
        className="flex items-center justify-between px-4 pt-4"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Studio
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {wasSubmit ? "Order logged" : "Preview"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {SHOW_STUDIO_REPLAY && (
            /* Replay animation — remounts the reveal choreography.
               Amber styling so it reads as a tooling control, not a
               primary action. Flip SHOW_STUDIO_REPLAY off when done
               recording / tuning. */
            <button
              type="button"
              onClick={() => setReplayCount((n) => n + 1)}
              aria-label="Replay animation"
              title="Replay animation"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] px-2.5 text-xs text-[hsl(var(--warning))] transition-colors hover:bg-[hsl(var(--warning)/0.2)]"
            >
              <Play size={11} />
              Replay
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            aria-label="Back to entry"
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCcw size={12} />
            Back
          </button>
        </div>
      </motion.header>

      {error && (
        <div
          role="alert"
          className="mx-4 rounded-md border border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-xs text-[hsl(var(--danger))]"
        >
          {error}
        </div>
      )}

      <AnimatePresence mode="wait">
        {data == null && !error ? (
          <LoadingSkeleton key="skeleton" />
        ) : data != null ? (
          // `initial={false}` skips the mount-time fade-in — otherwise
          // the wrapper's opacity animation would run in parallel with
          // the chart's Recharts line-draw and either mask it (if
          // wrapper fade is longer) or make the first frames of the
          // chart appear at 30-70% opacity, both of which killed the
          // "curve drawing itself in" effect in earlier iterations.
          // Child animations (chart sweep + cell staggers + roll-ups)
          // provide all the visual entrance we need.
          <motion.div
            // Key includes replayCount so Replay can force a full
            // unmount/remount → every animation restarts from t=0
            // (chart line-draw, pill fade, roll-ups, cell staggers).
            key={`content-${replayCount}`}
            className="flex flex-col gap-4"
            initial={false}
            animate={{ opacity: 1 }}
          >
            <GrowthChart data={data.chart} shouldAnimate={shouldAnimate} />
            <StatsRow stats={data.stats} shouldAnimate={shouldAnimate} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Barebones skeleton — matches the two shapes rendered by the
 *  reveal state (growth chart + 6-tile stats grid) so the layout
 *  doesn't jump when data lands. Uses `animate-pulse` (Tailwind's
 *  CSS keyframe) rather than framer so it costs zero JS while data
 *  is in-flight. */
function LoadingSkeleton() {
  return (
    <motion.div
      key="skeleton"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="flex flex-col gap-4"
    >
      <div
        className={`${STUDIO_CHART_HEIGHT_CLASS} w-full animate-pulse bg-muted/20`}
      />
      <div className="mx-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg border border-border bg-muted/20"
          />
        ))}
      </div>
    </motion.div>
  );
}
