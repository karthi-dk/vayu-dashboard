"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import type { StudioData } from "@/app/studio/data";
import { STUDIO_TIMING } from "@/components/studio/RevealDashboard";
import { RollUpNumber } from "@/components/studio/RollUpNumber";
import { VerdictReactive } from "@/components/studio/VerdictReactive";
import type { StudioTelemetryTheme } from "@/lib/studio/recordingTelemetry";
import { resolveVerdictTier, type VerdictTier } from "@/lib/studio/sounds";
import { cn, fmtCompactINR } from "@/lib/utils";

/**
 * StatsRow — six MF portfolio metrics arranged as one uniform grid.
 * 3-across × 2 rows on desktop (grid-cols-3), 2×3 on mobile portrait
 * (grid-cols-2). Every tile shares the same 3-row anatomy — label +
 * big value + subtle sub — with nbsp reservations where a slot is
 * unused, so all cells render at identical intrinsic height and the
 * grid reads as a perfectly aligned matrix.
 *
 * Tile layout (indices 0-5, reading order):
 *
 *   Row 1 — portfolio-level (per-time metrics):
 *   0. 1 DAY                — today's NAV-only ₹ movement (Σ per-fund
 *                             one_day_change_inr). Deposit-immune
 *                             after the 2026-07-27 recomputeNwDaily
 *                             fix. Tone-coloured. Sub shows the
 *                             matching 1D percentage (+/-X.XX%).
 *   1. TOTAL INVESTED       — lifetime money-in (fund_holdings sum).
 *                             Sub reserved (nbsp) — same reason.
 *   2. AVG DAILY EARNING    — unrealised gain ÷ days invested. Reframes
 *                             "gain" as a rate ("₹X per day just
 *                             sitting there") — small today, powerful
 *                             narrative fuel as compounding kicks in.
 *                             Sub carries the sample-size basis
 *                             ("over N days") so the number reads as
 *                             "N-day average", not "today's earning".
 *
 *   Row 2 — order-level (per-tap metrics):
 *   3. AVG ORDER SIZE       — lifetime purchase ₹ ÷ lifetime order
 *                             count. Answers "how much do I typically
 *                             put in per purchase". Uses gross
 *                             purchase amounts so redemptions don't
 *                             shrink the historical average. Sub
 *                             carries the order-count basis ("across
 *                             N orders") — mirrors the sample-size
 *                             pattern from AVG DAILY EARNING.
 *   4. AVG PROFIT PER ORDER — unrealised gain ÷ lifetime order count.
 *                             Structural mirror of AVG ORDER SIZE:
 *                             "₹22K in per order → ₹782 back per
 *                             order". Deliberately placed next to it
 *                             so the in/out pairing reads at a glance.
 *                             Same "across N orders" sub as its
 *                             mirror tile so the pair reads as a
 *                             single input→output pattern.
 *   5. TOTAL ORDERS         — combined order-cadence tile. Hero is
 *                             the lifetime count (rolls up) so the
 *                             big number matches the tile label with
 *                             no interpretation needed. Sub carries
 *                             the month-to-date context: "N this
 *                             month / ₹X". Anchors the row's "per-
 *                             order" story with the actual tap count.
 *
 *                             Hero was briefly the MTD count (24)
 *                             before we realised the label→value
 *                             mismatch — a tile called ORDERS with
 *                             "24" as the hero forced readers to
 *                             parse the sub to figure out what "24"
 *                             counted. Lifetime-count-as-hero is
 *                             self-labelling and reads at a glance.
 *
 * "Avg" prefix on three tiles (Row 1.2, Row 2.3, Row 2.4) is
 * deliberate: those metrics are all lifetime averages, and prefixing
 * makes that explicit so a reader doesn't misread AVG DAILY EARNING
 * as "today's earning" or PROFIT PER ORDER as "the profit on any
 * given order". The other three tiles (1 DAY, TOTAL INVESTED, TOTAL
 * ORDERS) are literal counts / point-in-time values, so they stay
 * plain. Same rule governs the subs: only the three "Avg" tiles
 * carry a sample-size sub; the literals get nbsp.
 *
 * History
 * -------
 * VALUE tile: dropped 2026-07-28 — chart's value pill already shows
 * current portfolio value prominently, so a dedicated tile was pure
 * duplication.
 * TOTAL GAIN tile: dropped 2026-07-28 — same reason. The pill
 * already renders "+3.50%" underneath the value, so surfacing the
 * identical number again in a stats tile added zero new information.
 * XIRR: deliberately absent — annualising ~6 months of a bull run
 * produces noise, not signal; reintroduce once the earliest tx_date
 * crosses ~2027-01 so the annualisation window is meaningful.
 * BEST TODAY / PEAK DAY / 30D: lived here 2026-07-25 → 2026-07-28,
 * removed when the grid absorbed the order-cadence numbers from the
 * (now-deleted) DailyProgressCard.
 * THIS MONTH ORDERS + TOTAL ORDERS as separate tiles: existed for
 * ~6 hours on 2026-07-28 before being merged into the single TOTAL
 * ORDERS tile here — two half-empty tiles were less useful than one
 * dense one, and freeing the slot brought the grid down to a
 * symmetric 4. Merged tile briefly used MTD count (24) as hero
 * before flipping to lifetime count (170) later the same day, when
 * we noticed a tile labelled ORDERS with "24" as the big number
 * required parsing the sub to figure out what "24" counted; making
 * the label "TOTAL ORDERS" and the hero "170" is self-labelling.
 * COMPOUND KICK (gain/value): considered and rejected 2026-07-28 —
 * numerically indistinguishable from GAIN% (3.50% vs 3.39%) at
 * current portfolio scale. Reintroduce once the portfolio doubles
 * or more, when the two ratios start telling different stories.
 * 4-tile → 6-tile re-expansion (2026-07-28 late night): once the
 * grid settled at 4 tiles (1D, Invested, ORDERS, placeholder), the
 * empty slot's prominence at 25% of the visible grid felt wasteful,
 * so we expanded back to 6 tiles by adding the three top shortlist
 * picks — DAILY EARNING RATE, AVG ORDER SIZE, PROFIT PER ORDER.
 * (AVG ORDER SIZE was briefly labelled AVG SIP SIZE on first pass
 * before we noticed only one of the user's funds is actually a
 * systematic-investment-plan; the label was corrected to be
 * accurate for a mostly-lumpsum portfolio.) Shortlist metrics that
 * didn't make this cut (POSITIVE DAYS, BEAT NIFTY BY, AVG DAILY
 * SWING) stay in the backlog for future rotation.
 *
 * Design intent
 * -------------
 * These are the auditable numbers of the page — the ones anyone
 * tracking the experiment would want screenshotted. Uniform tile
 * geometry is the whole point: every metric gets the same visual
 * weight, no "primary vs secondary" hierarchy, no ragged rows. The
 * nbsp fallbacks in `sub` are what enforce this — remove them and
 * rows will pop up/down as content varies.
 *
 * Animation
 * ---------
 * Cells cascade in from below at STATS_BASE (2580ms) with 100ms
 * stagger. All six tiles roll their values over STATS_ROLLUP (950ms)
 * — no static placeholder anymore. Last rolling cell (TOTAL ORDERS,
 * index 5) settles at exactly t=4030, aligning with the Slot Machine
 * rollup sound's jackpot ding at ~4030 to the millisecond.
 *
 * Stagger returned to 100ms (from the 4-tile era's 150ms) when the
 * grid re-expanded to 6 — with more tiles to cascade, tighter spacing
 * keeps the overall reveal at ~4s without any single tile feeling
 * lonely. STATS_BASE nudged to 2580 (from 2600) to keep the audio
 * sync millisecond-perfect at the new tile count.
 *
 * 1D verdict reaction
 * -------------------
 * The 1 DAY tile has a sign-tiered coda that fires ~970ms after
 * the rollup ding's decay clears (STUDIO_TIMING.VERDICT_BEGIN =
 * 5500ms), synced with the audio verdict from lib/studio/sounds.ts.
 * The wrapper component lives at components/studio/VerdictReactive.
 * tsx and is also imported by /studio/verdict (preview page) so
 * testers can compare tiers side-by-side. Four tiers, driven by
 * resolveVerdictTier(oneDayInr, oneDayPct):
 *
 *   • big-green (>+1%) — DENSE: triple scale bounce (max +12%)
 *                        + wider ±4° rotate + 12 sparkles + dual-
 *                        ring emerald halo. 1.5s visual.
 *   • green      (>0)  — standard double-bounce (max +8%) + ±2.5°
 *                        jiggle + 8 sparkles + single-ring emerald
 *                        halo. 1.5s visual.
 *   • flat  (|Δ|~0)    — no reaction. Silent tile, matches the
 *                        silent audio verdict.
 *   • red        (<0)  — HEAVY DENSE: pre-recoil wince (scaleY 1→
 *                        0.97) → deep collapse (0.80) → multi-stage
 *                        recovery + 14px settle + ±5.5° tilt +
 *                        triple-ring red halo. 2.0s visual. Fires
 *                        for ANY negative move regardless of
 *                        magnitude — see VerdictReactive docstring
 *                        for why losses are single-tiered.
 *
 * Design principle: celebrate wins loudly, acknowledge losses
 * gently, ignore noise. Markets are red ~40% of days — a sad-
 * particle rain on every red day would train a small daily
 * flinch, so red gets no particles. The wince + collapse + halo
 * pulse is expressive acknowledgement without punishment.
 *
 * Why the split between scale (green) and scaleY+y+rotate (red)?
 * Green tiers want a uniform pulse that reads as "vibrant" — same
 * X and Y stretch. Red wants the tile to *settle down*, a Y-only
 * compression paired with downward translation and slight tilt;
 * a uniform scale-down would read as "shrinking away", too
 * passive. This anatomy matches the audio: chime-up rises, minor-
 * descend falls, and the visual mirrors the sonic gesture.
 *
 * User-selectable synths
 * ----------------------
 * The green (incl. big-green) and red synth choices are user-
 * selectable — pick a style on /studio/sounds and both the
 * production 1 DAY tile and the /studio/verdict preview will
 * play the chosen synth. VerdictReactive doesn't need to know
 * which synth fires; playVerdict resolves that internally.
 *
 * Halo pulse (2026-07-29 addition): a colored boxShadow ring
 * pulses out from the tile edge over the same duration as the
 * transform. Colors hardcoded as rgba (green-500, red-500) because
 * framer-motion doesn't interpolate CSS var() references cleanly.
 * The halo is what makes the reaction perceivable at a glance —
 * pre-halo, the pure-transform version was too subtle to notice
 * without staring.
 *
 * Timing is guarded by shouldAnimate so the Skip path (which
 * suppresses all other cascade animation) also suppresses the
 * verdict reaction — silent instant render, no post-mount pulse.
 *
 * Test-mode disclaimer
 * --------------------
 * When NEXT_PUBLIC_FUNDS_TEST_MODE is on we surface a subtle line
 * under the row noting that these figures exclude test entries.
 * Prevents confusion during a recording session where the tester
 * has just submitted three rehearsal rows and wonders why the
 * numbers didn't move.
 */
export function StatsRow({
  stats,
  shouldAnimate = false,
  telemetryRunId,
  telemetryTheme = "unknown",
}: {
  stats: StudioData["stats"];
  shouldAnimate?: boolean;
  telemetryRunId?: string;
  telemetryTheme?: StudioTelemetryTheme;
}) {
  const {
    invested,
    oneDayInr,
    oneDayPct,
    monthInr,
    monthCount,
    totalOrders,
    daysInvested,
    avgOrderSize,
    dailyEarningRate,
    profitPerOrder,
    isTestMode,
  } = stats;
  const oneDayTone: "gain" | "loss" | "neutral" =
    oneDayInr == null || oneDayInr === 0
      ? "neutral"
      : oneDayInr > 0
        ? "gain"
        : "loss";
  const oneDayPctSub: ReactNode | undefined =
    oneDayPct != null
      ? (() => {
          const pct = Math.abs(oneDayPct) < 0.005 ? 0 : oneDayPct;
          return (
            <span
              className={cn(
                "font-medium tabular-nums",
                pct > 0 && "text-[hsl(var(--success))]",
                pct < 0 && "text-[hsl(var(--danger))]",
                pct === 0 && "text-muted-foreground/80"
              )}
            >
              {`${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}
            </span>
          );
        })()
      : undefined;
  // Verdict tier drives the 1D-tile reactive animation. Same
  // resolver the audio verdict uses (lib/studio/sounds.ts), so
  // sight and sound are guaranteed to agree on the tier.
  const verdictTier: VerdictTier = resolveVerdictTier(oneDayInr, oneDayPct);
  // DAILY EARNING and PROFIT PER ORDER share the same tone rule as
  // 1D — they can go red on a bad run of days / net-loss portfolio,
  // in which case tone-colouring makes the loss visually obvious.
  const dailyEarningTone: "gain" | "loss" | "neutral" =
    dailyEarningRate == null || dailyEarningRate === 0
      ? "neutral"
      : dailyEarningRate > 0
        ? "gain"
        : "loss";
  const profitPerOrderTone: "gain" | "loss" | "neutral" =
    profitPerOrder == null || profitPerOrder === 0
      ? "neutral"
      : profitPerOrder > 0
        ? "gain"
        : "loss";
  const cellDelay = (i: number) =>
    STUDIO_TIMING.STATS_BASE + i * STUDIO_TIMING.STATS_STAGGER;
  const rollupTelemetry = (metric: string) =>
    telemetryRunId
      ? {
          runId: telemetryRunId,
          theme: telemetryTheme,
          metric,
        }
      : undefined;

  // Sub for the combined TOTAL ORDERS tile: "N this month / ₹X".
  // The hero (totalOrders) matches the tile label unambiguously,
  // so the sub only needs to carry the MTD context. Slash separator
  // reads as a dense "count / amount" pair — same convention as
  // "24 orders / ₹2.23 L worth" that a reader would use verbally.
  const ordersSub = (
    <>
      {monthCount.toLocaleString("en-IN")} this month
      <span className="text-muted-foreground/60">{" / "}</span>
      {fmtCompactINR(monthInr)}
    </>
  );

  // Shared sub for AVG ORDER SIZE and AVG PROFIT PER ORDER — both
  // are lifetime-order-count averages, so both surface the same
  // sample-size basis ("across N orders"). DRY-ed so a future
  // wording change (e.g. "across" → "over") stays in one place and
  // the two tiles never drift apart. Undefined (→ nbsp fallback)
  // when the ledger has no orders yet, matching the "—" state of
  // the tiles' hero values.
  const orderCountSub: string | undefined =
    totalOrders > 0
      ? `across ${totalOrders.toLocaleString("en-IN")} order${
          totalOrders === 1 ? "" : "s"
        }`
      : undefined;

  return (
    <section aria-label="Portfolio stats" className="mx-4 flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MotionCell delayMs={cellDelay(0)} animate={shouldAnimate}>
          <VerdictReactive tier={verdictTier} animate={shouldAnimate}>
            <Stat
              label="1 Day"
              tone={oneDayTone}
              value={
                oneDayInr != null ? (
                  <RollUpNumber
                    value={oneDayInr}
                    // Suppress the "+₹0" flash at displayed=0 that
                    // fmtCompactINR({sign:true}) would produce for
                    // one animation frame at t=0 — masks the sign-
                    // transition for negative targets rolling down
                    // through zero.
                    format={(n) =>
                      Math.abs(n) < 1 ? "₹0" : fmtCompactINR(n, { sign: true })
                    }
                    animate={shouldAnimate}
                    delay={cellDelay(0)}
                    duration={STUDIO_TIMING.STATS_ROLLUP}
                    telemetry={rollupTelemetry("stats.oneDayInr")}
                  />
                ) : (
                  "—"
                )
              }
              sub={oneDayPctSub}
            />
          </VerdictReactive>
        </MotionCell>

        <MotionCell delayMs={cellDelay(1)} animate={shouldAnimate}>
          <Stat
            label="Total invested"
            value={
              invested > 0 ? (
                <RollUpNumber
                  value={invested}
                  format={fmtCompactINR}
                  animate={shouldAnimate}
                  delay={cellDelay(1)}
                  duration={STUDIO_TIMING.STATS_ROLLUP}
                  telemetry={rollupTelemetry("stats.invested")}
                />
              ) : (
                "—"
              )
            }
          />
        </MotionCell>

        <MotionCell delayMs={cellDelay(2)} animate={shouldAnimate}>
          <Stat
            label="Avg daily earning"
            tone={dailyEarningTone}
            value={
              dailyEarningRate != null ? (
                <RollUpNumber
                  value={dailyEarningRate}
                  // Sign shown so a losing run reads as "−₹120"
                  // instead of "₹120" (ambiguous). Same "₹0 for
                  // near-zero" guard as 1D so the rollup doesn't
                  // flash "+₹0" while ticking through 0.
                  format={(n) =>
                    Math.abs(n) < 1 ? "₹0" : fmtCompactINR(n, { sign: true })
                  }
                  animate={shouldAnimate}
                  delay={cellDelay(2)}
                  duration={STUDIO_TIMING.STATS_ROLLUP}
                  telemetry={rollupTelemetry("stats.dailyEarningRate")}
                />
              ) : (
                "—"
              )
            }
            // Sub carries the days-invested basis: "over N days" is
            // the sample-size the average is computed against. Label
            // already says "Avg", so "avg over N days" would double-
            // count the qualifier — "over N days" alone is precise
            // and matches the "across N orders" wording used by the
            // two order-count tiles below.
            sub={
              daysInvested != null
                ? `over ${daysInvested.toLocaleString("en-IN")} day${
                    daysInvested === 1 ? "" : "s"
                  }`
                : undefined
            }
          />
        </MotionCell>

        <MotionCell delayMs={cellDelay(3)} animate={shouldAnimate}>
          <Stat
            label="Avg order size"
            value={
              avgOrderSize != null ? (
                <RollUpNumber
                  value={avgOrderSize}
                  format={fmtCompactINR}
                  animate={shouldAnimate}
                  delay={cellDelay(3)}
                  duration={STUDIO_TIMING.STATS_ROLLUP}
                  telemetry={rollupTelemetry("stats.avgOrderSize")}
                />
              ) : (
                "—"
              )
            }
            // "across N orders" replaces the earlier "per order":
            // the label already says AVG ORDER SIZE, so "per order"
            // was pure duplication (user flagged 2026-07-28). The
            // count-basis sub is genuinely informative and mirrors
            // AVG DAILY EARNING's "over N days" pattern.
            sub={orderCountSub}
          />
        </MotionCell>

        <MotionCell delayMs={cellDelay(4)} animate={shouldAnimate}>
          <Stat
            label="Avg profit per order"
            tone={profitPerOrderTone}
            value={
              profitPerOrder != null ? (
                <RollUpNumber
                  value={profitPerOrder}
                  format={(n) =>
                    Math.abs(n) < 1 ? "₹0" : fmtCompactINR(n, { sign: true })
                  }
                  animate={shouldAnimate}
                  delay={cellDelay(4)}
                  duration={STUDIO_TIMING.STATS_ROLLUP}
                  telemetry={rollupTelemetry("stats.profitPerOrder")}
                />
              ) : (
                "—"
              )
            }
            // Shares `orderCountSub` with AVG ORDER SIZE — same
            // denominator (lifetime order count), so the two tiles
            // read as one input→output pair with matching sample-
            // size context. Sub was "avg return" pre-2026-07-28
            // before we noticed "Avg" in the label already covers
            // that qualifier.
            sub={orderCountSub}
          />
        </MotionCell>

        <MotionCell delayMs={cellDelay(5)} animate={shouldAnimate}>
          <Stat
            label="Total orders"
            value={
              <RollUpNumber
                value={totalOrders}
                // Integer count — round both the animating value and
                // the final so the rollup ticks through whole numbers
                // (not 168.4 → 169.7 → 170), matching every other
                // "count" display in the app. toLocaleString for
                // graceful grouping once the lifetime tally crosses
                // ~1000 orders ("1,000" not "1000", en-IN convention).
                format={(n) => Math.round(n).toLocaleString("en-IN")}
                animate={shouldAnimate}
                delay={cellDelay(5)}
                duration={STUDIO_TIMING.STATS_ROLLUP}
                telemetry={rollupTelemetry("stats.totalOrders")}
              />
            }
            // Sub stays static — the hero count rolls, the MTD
            // reference numbers below it don't. A rolling small
            // number would fight the big count above and read as
            // noise. Zero-safe: monthCount=0 renders "0 this month",
            // fmtCompactINR(0) → "₹0" for a fresh month with no
            // orders yet.
            sub={ordersSub}
          />
        </MotionCell>
      </div>
      {isTestMode && (
        <p className="text-center text-[10px] text-muted-foreground/80">
          Figures exclude rehearsal rows (
          <code className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[9px]">
            platform=test
          </code>
          ).
        </p>
      )}
    </section>
  );
}

/** Framer-motion wrapper for the cell entrance. Same easing curve
 *  across every tile so the six-cell cascade reads as one visual
 *  motion rather than six independent ones. */
function MotionCell({
  children,
  delayMs,
  animate,
}: {
  children: ReactNode;
  delayMs: number;
  animate: boolean;
}) {
  return (
    <motion.div
      initial={
        animate ? { opacity: 0, y: 10, scale: 0.985, filter: "blur(3px)" } : false
      }
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      transition={{
        delay: animate ? delayMs / 1000 : 0,
        duration: 0.45,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {children}
    </motion.div>
  );
}

/** A single stat tile. Three text rows — label, big value, subtle
 *  sub — with a non-breaking-space fallback for sub so every tile
 *  ends up at the exact same intrinsic height. That's what makes
 *  the grid render as a uniform matrix without needing explicit
 *  min-heights or `auto-rows-fr` gymnastics; if you shorten the
 *  Stat body in future, keep the sub slot reserved or the grid
 *  will start jumping row heights based on which tiles have subs.
 *
 *  Tone controls whether the big value is coloured as a gain,
 *  loss, or neutral. Colour is only meaningful on signed metrics
 *  (1D, Gain %) — counts and rupees stay neutral because there's
 *  no "bad" value for TOTAL INVESTED or TOTAL ORDERS. */
function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "gain" | "loss";
}) {
  return (
    <div className="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-background px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "gain" && "text-[hsl(var(--success))]",
          tone === "loss" && "text-[hsl(var(--danger))]",
          tone === "neutral" && "text-foreground"
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground/80">
        {sub ?? "\u00A0"}
      </span>
    </div>
  );
}
