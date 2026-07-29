"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import successConfetti from "@/lib/studio/animations/success_confetti.json";
import { playCracker } from "@/lib/studio/sounds";

/**
 * CelebrationOverlay — the confetti burst between a successful
 * order submit and the reveal dashboard.
 *
 * Flow
 * ----
 *   Submit → server action succeeds → page transitions to
 *   'celebrating' → this mounts (portaled to document.body) →
 *   Lottie plays to completion → onComplete advances to 'reveal'.
 *
 * Centering / first-paint race
 * ---------------------------
 * An intermittent bug showed the burst stuck too far right (half
 * clipped) on fresh load, then jumping to true center mid-play.
 * Causes we harden against:
 *
 *   1. Theme-scope ancestors (transform / filter / contain) can
 *      make `position: fixed` resolve against a non-viewport box.
 *      Portal to `document.body` so fixed is always viewport-relative.
 *
 *   2. Entry form unmount removes the scrollbar in the same commit
 *      the overlay mounts. Lottie measured against the pre-shift
 *      width, then a later resize recentered mid-animation.
 *      Lock `html`/`body` overflow while mounted.
 *
 *   3. `aspect-square w-full max-w-[…]` + `h-full` left the Lottie
 *      container with an unstable first layout (width 100%, height
 *      pending). Use an explicit equal width+height `min(90vw,90dvh)`
 *      box, delay autoplay until that box has non-zero size, then
 *      call `resize()` before `play()`.
 *
 * Skip semantics
 * --------------
 * Entry Skip bypasses this stage (straight to reveal). No skip UI
 * here.
 */

/** Native duration — 160 frames @ 60fps ≈ 2666.67ms. */
const LOTTIE_NATIVE_DURATION_MS = 2670;

/** Desired playback window (ms). Lottie is sped up to fit. */
const LOTTIE_DURATION_MS = 2500;

const LOTTIE_SPEED = LOTTIE_NATIVE_DURATION_MS / LOTTIE_DURATION_MS;

const FALLBACK_BUFFER_MS = 130;

/** Explicit square size — same value for width and height so the
 *  first layout is stable (no aspect-ratio deferred height). */
const SQUARE_SIZE = "min(90vw, 90dvh)";

export default function CelebrationOverlay({ onDone }: { onDone: () => void }) {
  const pathname = usePathname();
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);

  // Portaled outside `.studio-glassmorphic-scope`, so keep the aurora
  // visible under the burst on that theme (no solid curtain).
  const transparentBackdrop = pathname?.includes("/studio/glassmorphic");

  const advance = () => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    onDone();
  };

  // Client-only portal target.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Lock scroll so entry→celebrating scrollbar collapse cannot
  // reflow the Lottie mid-burst.
  useEffect(() => {
    if (!mounted) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, [mounted]);

  // Wait until the square box has a real size, then allow play.
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    let attempts = 0;

    const tryReady = () => {
      if (cancelled) return;
      const el = boxRef.current;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      if (w > 0 && h > 0) {
        setReady(true);
        return;
      }
      attempts += 1;
      if (attempts < 30) {
        requestAnimationFrame(tryReady);
      } else {
        // Give up waiting — still play so we never soft-lock.
        setReady(true);
      }
    };

    requestAnimationFrame(tryReady);
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  // Sound + speed + fallback once the player is allowed to run.
  // Lottie only mounts after `ready`, so its first measure sees the
  // stable square — no mid-burst recentering from a bad first layout.
  useEffect(() => {
    if (!ready) return;

    playCracker();

    const syncPlayer = () => {
      const anim = lottieRef.current;
      if (!anim) return;
      anim.setSpeed(LOTTIE_SPEED);
      anim.animationItem?.resize();
    };

    // Ref populates after Lottie mounts in this same commit cycle.
    const raf1 = requestAnimationFrame(() => {
      syncPlayer();
      requestAnimationFrame(syncPlayer);
    });

    const fallbackId = window.setTimeout(
      advance,
      LOTTIE_DURATION_MS + FALLBACK_BUFFER_MS
    );
    return () => {
      cancelAnimationFrame(raf1);
      window.clearTimeout(fallbackId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={
        transparentBackdrop
          ? "fixed inset-0 z-40 flex items-center justify-center bg-transparent"
          : "fixed inset-0 z-40 flex items-center justify-center bg-background"
      }
      // Pin to the layout viewport explicitly. Avoid 100vw (includes
      // scrollbar gutter on some engines and can bias the flex box).
      style={{ width: "100%", height: "100%" }}
      aria-hidden
    >
      <div
        ref={boxRef}
        className="relative shrink-0"
        style={{ width: SQUARE_SIZE, height: SQUARE_SIZE }}
      >
        {ready && (
          <Lottie
            lottieRef={lottieRef}
            animationData={successConfetti}
            loop={false}
            autoplay
            onComplete={advance}
            rendererSettings={{
              preserveAspectRatio: "xMidYMid meet",
            }}
            style={{ width: "100%", height: "100%" }}
            className="h-full w-full"
          />
        )}
      </div>
    </div>,
    document.body
  );
}
