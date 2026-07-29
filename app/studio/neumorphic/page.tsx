"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { NeumorphicOrderEntryLanding } from "@/components/studio/NeumorphicOrderEntryLanding";
import { RevealDashboard } from "@/components/studio/RevealDashboard";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import { TestModeBanner } from "@/components/studio/TestModeBanner";
import { getStudioData, type StudioData } from "@/app/studio/data";

/**
 * /studio/neumorphic — style-prototype clone of /studio.
 *
 * Same state machine (entry → celebrating → reveal), same
 * animation choreography, same DB writes, same forceError dev
 * hook. Only the entry-form aesthetic is swapped: soft blue-gray
 * neumorphic surface with extruded/debossed depth cues instead of
 * the flat indigo-primary look on /studio.
 *
 * Reveal stage still uses the production RevealDashboard because:
 *   1. Chart data-viz doesn't play nicely with neumorphism (dense
 *      grids fight the "everything is one surface" premise).
 *   2. Keeping the reveal identical means the A/B comparison is
 *      purely about the ENTRY form, not confounded by chart
 *      styling drift.
 *
 * Route inherits the /studio full-bleed + no-TopNav treatment via
 * the `startsWith("/studio/")` check in app/layout.tsx — no extra
 * plumbing required.
 *
 * Sunset expectation
 * ------------------
 * If the user approves the neumorphic direction, this route and
 * its component get promoted into /studio (replacing
 * OrderEntryLanding). If not, both files are safe to delete —
 * nothing imports them.
 */

const CelebrationOverlay = dynamic(
  () => import("@/components/studio/CelebrationOverlay"),
  {
    ssr: false,
    // Neumorphic-surface fallback to keep the transition from
    // entry → celebrating from flashing a dark page background
    // while the ~127KB Lottie chunk resolves.
    loading: () => <div className="min-h-dvh w-full bg-[#e0e5ec]" />,
  },
);

type Stage = "entry" | "celebrating" | "reveal";

export default function NeumorphicStudioPage() {
  const [stage, setStage] = useState<Stage>("entry");
  const [enteredViaSubmit, setEnteredViaSubmit] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);
  // See /studio/page.tsx for the full rationale on this preload
  // pattern — briefly: kick off getStudioData() during the
  // celebrating stage so the reveal has data ready to render on
  // its first paint, avoiding the LoadingSkeleton flash.
  const [preloadedData, setPreloadedData] = useState<StudioData | null>(null);

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
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stage]);

  return (
    // Page-level neumorphic surface. Padding at the top gives the
    // card a bit of breathing room from the TEST MODE banner
    // (when NEXT_PUBLIC_FUNDS_TEST_MODE=true) and the top of the
    // viewport on desktop. On mobile the card fills the width;
    // desktop caps at max-w-md inside the card.
    //
    // `studio-neumorphic-scope` is defined in app/globals.css. It
    // overrides Vayu's HSL theme variables (--background, --foreground,
    // --primary, etc.) to the neumorphic palette and injects
    // scoped card-shell shadows for the StatsRow tiles and value-pill
    // patterns. This lets the reveal stage (GrowthChart + StatsRow,
    // both unchanged production components) render in the neumorphic
    // aesthetic without a line of duplicated component code.
    <div className="studio-neumorphic-scope min-h-dvh bg-[#e0e5ec] py-6">
      <StudioClickSound />
      <StudioClickPulse />
      <TestModeBanner />
      {stage === "entry" && (
        <NeumorphicOrderEntryLanding
          onSubmitted={() => {
            setEnteredViaSubmit(true);
            setRefreshKey((k) => k + 1);
            setStage("celebrating");
          }}
          onSkipped={() => {
            setEnteredViaSubmit(false);
            setStage("reveal");
          }}
        />
      )}
      {stage === "celebrating" && (
        <CelebrationOverlay onDone={() => setStage("reveal")} />
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
        />
      )}
    </div>
  );
}
