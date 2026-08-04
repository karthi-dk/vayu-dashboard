"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export type SubmitBurstTheme =
  | "classic"
  | "claymorphic"
  | "glassmorphic"
  | "neumorphic"
  | "skeuomorphic";

/** Burst lifetime — independent of API latency; the flourish always
 *  gets to play, even when logMfTransaction resolves near-instantly. */
const BURST_MS = 800;

/**
 * SubmitBurst — themed flourish over the "Log allotment" CTA.
 *
 * Mount once per tap by keying the call site off
 * `useOrderEntryForm`'s `submitPulseKey` (`<SubmitBurst key={submitPulseKey} .../>`).
 * Purely decorative: it neither reads nor affects submit/pending
 * state, so it can't regress the actual logging flow. Self-unmounts
 * after BURST_MS via its own timer.
 */
export function SubmitBurst({ theme }: { theme: SubmitBurstTheme }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setVisible(false);
      return;
    }
    const timerId = window.setTimeout(() => setVisible(false), BURST_MS);
    return () => window.clearTimeout(timerId);
  }, []);

  if (!visible) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <AnimatePresence>{renderBurst(theme)}</AnimatePresence>
    </div>
  );
}

function renderBurst(theme: SubmitBurstTheme) {
  switch (theme) {
    case "claymorphic":
      return <ClayBurst />;
    case "glassmorphic":
      return <GlassBurst />;
    case "neumorphic":
      return <NeumorphicBurst />;
    case "skeuomorphic":
      return <SkeuomorphicBurst />;
    case "classic":
    default:
      return <ClassicBurst />;
  }
}

/** Classic — two soft rings expanding outward from the primary hue. */
function ClassicBurst() {
  return (
    <>
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          className="absolute h-6 w-6 rounded-full border-2 border-[hsl(var(--primary))]"
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 6 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.75, delay: i * 0.15, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/** Claymorphic — six colour-chip dots pop outward, echoing the
 *  field-icon palette used on the entry form. */
const CLAY_DOT_COLORS = [
  "#a78bfa",
  "#4ade80",
  "#fbbf24",
  "#60a5fa",
  "#fb7185",
  "#e879f9",
];

function ClayBurst() {
  return (
    <>
      {CLAY_DOT_COLORS.map((color, i) => {
        const angle = (i / CLAY_DOT_COLORS.length) * Math.PI * 2;
        const dx = Math.cos(angle) * 46;
        const dy = Math.sin(angle) * 46;
        return (
          <motion.span
            key={color}
            className="absolute h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: color }}
            initial={{ opacity: 1, x: 0, y: 0, scale: 0.4 }}
            animate={{ opacity: 0, x: dx, y: dy, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
          />
        );
      })}
    </>
  );
}

/** Glassmorphic — a diagonal light sweep plus a few sparkles
 *  drifting up, matching the frosted CTA's fuchsia/indigo gradient. */
function GlassBurst() {
  return (
    <>
      <span className="absolute inset-0 overflow-hidden rounded-2xl">
        <motion.span
          className="absolute inset-y-0 w-1/2"
          style={{
            background:
              "linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.65) 50%, transparent 80%)",
          }}
          initial={{ x: "-120%", opacity: 0.9 }}
          animate={{ x: "220%", opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, ease: "easeInOut" }}
        />
      </span>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute h-1.5 w-1.5 rounded-full bg-white"
          style={{ left: `${30 + i * 20}%` }}
          initial={{ y: 6, opacity: 0.9 }}
          animate={{ y: -26, opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, delay: i * 0.1, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/** Neumorphic — soft concentric rings, calmer/slower than the other
 *  themes to match the "meditative" palette philosophy. */
function NeumorphicBurst() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute h-5 w-5 rounded-full"
          style={{
            boxShadow:
              "0 0 0 1.5px rgba(255,255,255,0.6), inset 0 0 0 1.5px rgba(163,177,198,0.5)",
          }}
          initial={{ opacity: 0.5, scale: 1 }}
          animate={{ opacity: 0, scale: 5 + i }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.85, delay: i * 0.12, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/** Skeuomorphic — a warm brass "wax seal" glow + a press-ring,
 *  matching the leather/parchment palette. */
function SkeuomorphicBurst() {
  return (
    <>
      <motion.span
        className="absolute h-[70px] w-[70px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,224,161,0.55) 0%, rgba(212,160,74,0.25) 45%, transparent 70%)",
        }}
        initial={{ opacity: 0.9, scale: 0.3 }}
        animate={{ opacity: 0, scale: 1.6 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      />
      <motion.span
        className="absolute h-7 w-7 rounded-full border-2"
        style={{ borderColor: "#c99a52" }}
        initial={{ opacity: 0.8, scale: 1 }}
        animate={{ opacity: 0, scale: 3.2 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.65, delay: 0.05, ease: "easeOut" }}
      />
    </>
  );
}
