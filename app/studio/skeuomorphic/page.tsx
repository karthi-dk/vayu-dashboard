"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SkeuomorphicOrderEntryLanding } from "@/components/studio/SkeuomorphicOrderEntryLanding";
import { RevealDashboard } from "@/components/studio/RevealDashboard";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import { getStudioData, type StudioData } from "@/app/studio/data";

/**
 * /studio/skeuomorphic — style-prototype clone of /studio.
 *
 * Same interaction flow as the base Studio route (entry -> celebrating
 * -> reveal) with a tactile skeuomorphic skin: warm paper/leather
 * palette, heavier borders, and raised card surfaces.
 *
 * Sunset expectation
 * ------------------
 * If this direction is preferred, it can replace /studio. If not,
 * this route is additive and safe to remove.
 */

const CelebrationOverlay = dynamic(
  () => import("@/components/studio/CelebrationOverlay"),
  {
    ssr: false,
    loading: () => <div className="min-h-dvh w-full bg-[#e8decd]" />,
  }
);

type Stage = "entry" | "celebrating" | "reveal";

export default function SkeuomorphicStudioPage() {
  const [stage, setStage] = useState<Stage>("entry");
  const [enteredViaSubmit, setEnteredViaSubmit] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);
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
    <div className="studio-skeuomorphic-scope min-h-dvh bg-[#e8decd] py-6">
      <StudioClickSound />
      <StudioClickPulse />
      {stage === "entry" && (
        <SkeuomorphicOrderEntryLanding
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
          studioTheme="skeuomorphic"
        />
      )}
    </div>
  );
}
