"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ClaymorphicOrderEntryLanding } from "@/components/studio/ClaymorphicOrderEntryLanding";
import { RevealDashboard } from "@/components/studio/RevealDashboard";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import { TestModeBanner } from "@/components/studio/TestModeBanner";
import { getStudioData, type StudioData } from "@/app/studio/data";

/**
 * /studio/claymorphic — style-prototype clone of /studio.
 *
 * Same state machine (entry → celebrating → reveal), same
 * animation choreography, same DB writes. The entry form is a
 * clay-language variant (chunky pillow surfaces, saturated
 * violet CTA); the reveal stage inherits the clay palette via
 * the `.studio-claymorphic-scope` class defined in globals.css.
 *
 * Sunset expectation
 * ------------------
 * If clay wins the vote, this route replaces /studio. If not,
 * both files delete cleanly — nothing else in the app references
 * them.
 */

const CelebrationOverlay = dynamic(
  () => import("@/components/studio/CelebrationOverlay"),
  {
    ssr: false,
    // Fallback matches the periwinkle page shell so the entry →
    // celebrating transition doesn't flash a dark background
    // while the Lottie chunk resolves.
    loading: () => <div className="min-h-dvh w-full bg-[#eef1f9]" />,
  },
);

type Stage = "entry" | "celebrating" | "reveal";

export default function ClaymorphicStudioPage() {
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
    <div className="studio-claymorphic-scope min-h-dvh bg-[#eef1f9] py-6">
      <StudioClickSound />
      <StudioClickPulse />
      <TestModeBanner />
      {stage === "entry" && (
        <ClaymorphicOrderEntryLanding
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
