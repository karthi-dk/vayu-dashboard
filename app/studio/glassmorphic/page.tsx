"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { GlassmorphicOrderEntryLanding } from "@/components/studio/GlassmorphicOrderEntryLanding";
import { RevealDashboard } from "@/components/studio/RevealDashboard";
import { StudioClickPulse } from "@/components/studio/StudioClickPulse";
import { StudioClickSound } from "@/components/studio/StudioClickSound";
import { getStudioData, type StudioData } from "@/app/studio/data";

/**
 * /studio/glassmorphic — style-prototype clone of /studio.
 *
 * Same state machine (entry → celebrating → reveal), same
 * animation choreography, same DB writes. The entry form is a
 * glass-surface variant; the reveal stage inherits the
 * glassmorphic palette via the `.studio-glassmorphic-scope` class
 * defined in globals.css (which overrides Vayu's HSL theme
 * variables and injects backdrop-blur-based shadow rules keyed on
 * the reveal children's card-shell class patterns).
 *
 * Why the aurora backdrop lives on this page (not the card)
 * ---------------------------------------------------------
 * Glassmorphism reduces to "semi-transparent white blob" without
 * a vivid backdrop. The blur+saturate signature only reads as
 * "glass" when there's rich colour underneath to warp. So the
 * page owns the aurora gradient (radial blobs of violet, pink,
 * blue over a deep indigo base) and every card sits ON that
 * backdrop, letting the colour bleed through.
 *
 * Sunset expectation
 * ------------------
 * If the glass direction is preferred, this route replaces
 * /studio. If not, both files (page.tsx +
 * Glassmorphic* components) delete cleanly — nothing else in the
 * app references them.
 */

const CelebrationOverlay = dynamic(
  () => import("@/components/studio/CelebrationOverlay"),
  {
    ssr: false,
    // Fallback matches the aurora base so the entry → celebrating
    // transition doesn't flash a light background while the
    // Lottie chunk resolves.
    loading: () => <div className="min-h-dvh w-full bg-[#0f172a]" />,
  },
);

type Stage = "entry" | "celebrating" | "reveal";

// Aurora gradient — layered radial blobs over a deep indigo base.
// Applied via inline `style={AURORA_BG}` so we can express the
// multi-stop stack cleanly without Tailwind arbitrary-value
// gymnastics. `background-attachment: fixed` keeps the blobs
// stationary during scroll so the glass surfaces sample a
// consistent backdrop — otherwise blurred content shifts around
// under the card as the user scrolls, which looks wrong.
const AURORA_BG: React.CSSProperties = {
  background: [
    "radial-gradient(ellipse 60% 40% at 20% 15%, rgba(139, 92, 246, 0.65), transparent 60%)",
    "radial-gradient(ellipse 50% 40% at 85% 25%, rgba(236, 72, 153, 0.55), transparent 60%)",
    "radial-gradient(ellipse 70% 45% at 50% 75%, rgba(59, 130, 246, 0.50), transparent 60%)",
    "radial-gradient(ellipse 80% 50% at 30% 100%, rgba(168, 85, 247, 0.40), transparent 60%)",
    "linear-gradient(180deg, #1e1b4b 0%, #0f172a 100%)",
  ].join(", "),
  backgroundAttachment: "fixed",
};

export default function GlassmorphicStudioPage() {
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
    <div
      className="studio-glassmorphic-scope min-h-dvh py-6"
      style={AURORA_BG}
    >
      <StudioClickSound />
      <StudioClickPulse />
      {stage === "entry" && (
        <GlassmorphicOrderEntryLanding
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
          studioTheme="glassmorphic"
        />
      )}
    </div>
  );
}
