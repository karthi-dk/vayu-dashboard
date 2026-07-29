"use client";

import { useEffect } from "react";

/**
 * StudioClickPulse — the VISUAL counterpart to StudioClickSound.
 * Mounts a single document-level pointerdown listener; every tap on
 * an interactive element spawns a small ring at the tap point that
 * scales outward and fades over ~500ms, then removes itself.
 *
 * WHY POINTERDOWN, NOT CLICK
 * ───────────────────────────
 * StudioClickSound uses `click` (fires on tap RELEASE), which is
 * the browser's action-commit event and the right time to *sound*
 * a commit. StudioClickPulse uses `pointerdown` (fires on tap
 * PRESS) because for VIDEO the visual should light up the instant
 * the finger touches the screen — the click event fires ~100-300ms
 * later after the release, which reads as a laggy indicator on
 * screen recording. The 100-300ms offset between visual (press)
 * and audio (release) is imperceptible during normal tapping —
 * both feel like "I tapped, it responded".
 *
 * WHY GLOBAL, NOT PER-BUTTON
 * ───────────────────────────
 * Same reasoning as StudioClickSound: sprinkling ring-on-tap
 * handlers everywhere is repetitive and misses interactions we
 * don't own (native `<select>` options, `<input type="date">`
 * picker cells). A single document listener catches every trusted
 * gesture, present and future, with zero per-button wiring.
 *
 * TARGET FILTERING
 * ────────────────
 * Mirrors StudioClickSound's whitelist so audio and visual fire on
 * the SAME set of gestures: buttons, selects, radios/checkboxes,
 * date/time pickers, labels, options, dropdowns. Skips text-family
 * inputs (typing shouldn't flash), textareas, contenteditable,
 * and untrusted (JS-synthesised) events.
 *
 * TAPS ON PAGE BACKGROUND
 * ───────────────────────
 * Skipped — a ring flashing on empty space during recording would
 * signal a tap that had no effect, which looks like a broken
 * interaction. Only taps on things that MEAN something get the
 * visual.
 *
 * REDUCED MOTION
 * ──────────────
 * If the user has `prefers-reduced-motion: reduce` set at the OS
 * level, we never spawn the pulse element. The CSS also has a
 * media-query backstop that suppresses the animation if a ring
 * somehow slips through.
 *
 * LIFECYCLE / MEMORY
 * ──────────────────
 * Each ring registers a one-shot `animationend` listener that
 * removes the DOM node when the 500ms animation completes. A
 * defensive 700ms setTimeout also removes any node that outlives
 * its animation (unlikely but guards against browsers that stall
 * animations on background tabs). Renders nothing.
 */
export function StudioClickPulse(): null {
  useEffect(() => {
    /** Reduced-motion check at listener install time. If the user
     *  toggles the OS setting mid-session, they'd need to refresh
     *  the page to pick it up — acceptable tradeoff for the
     *  simpler code path. */
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;

    /** Selectors matching StudioClickSound's interactive whitelist.
     *  Kept in sync so a tap that sounds also flashes. The role-*
     *  entries catch our themed dropdown options (rendered as
     *  <li role="option"> because native <option> can't be
     *  styled) — without them, picking an option in a Neumorphic
     *  / Glassmorphic / Claymorphic Select wouldn't flash. */
    const CLICKABLE_SELECTOR = [
      "button",
      '[role="button"]',
      "select",
      "a[href]",
      "option",
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
      '[role="tab"]',
      '[role="radio"]',
      '[role="switch"]',
      "label",
      'input[type="radio"]',
      'input[type="checkbox"]',
      'input[type="submit"]',
      'input[type="reset"]',
      'input[type="button"]',
      'input[type="date"]',
      'input[type="time"]',
      'input[type="datetime-local"]',
      'input[type="month"]',
      'input[type="week"]',
      'input[type="color"]',
      'input[type="file"]',
      'input[type="range"]',
    ].join(", ");

    const TEXT_INPUT_TYPES = new Set([
      "text",
      "number",
      "tel",
      "email",
      "url",
      "search",
      "password",
    ]);

    const onPointerDown = (e: PointerEvent) => {
      // Only real user gestures — synthesised pointer events
      // (rare, but possible via automation) shouldn't flash.
      if (!e.isTrusted) return;

      const target = e.target;
      if (!(target instanceof Element)) return;

      // Skip taps on text-focus surfaces.
      if (
        target instanceof HTMLInputElement &&
        TEXT_INPUT_TYPES.has(target.type)
      ) {
        return;
      }
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;

      // Only flash if the tap landed on an interactive element
      // (walk up the DOM to catch <span> children of buttons etc).
      const clickable = target.closest(CLICKABLE_SELECTOR);
      if (!clickable) return;
      // Guard against .closest() matching a text input at the top.
      if (
        clickable instanceof HTMLInputElement &&
        TEXT_INPUT_TYPES.has(clickable.type)
      ) {
        return;
      }

      // Spawn the ring at the pointer's viewport coordinates. Using
      // clientX/Y (not pageX/Y) so the ring stays anchored on
      // screen even if the page is scrolled during animation.
      const pulse = document.createElement("div");
      pulse.className = "studio-click-pulse";
      pulse.style.left = `${e.clientX}px`;
      pulse.style.top = `${e.clientY}px`;
      document.body.appendChild(pulse);

      // Cleanup: remove the node when the animation completes.
      // { once: true } auto-unsubscribes after first fire.
      const cleanup = () => pulse.remove();
      pulse.addEventListener("animationend", cleanup, { once: true });

      // Defensive fallback removal — if the browser stalls the
      // animation (background tab, page throttled), we still tidy
      // up after 700ms. Idempotent: .remove() on an already-removed
      // node throws no error.
      window.setTimeout(cleanup, 700);
    };

    // Capture phase to run before any component-level handlers
    // that might stopPropagation. addEventListener treats a bare
    // boolean third arg as the `capture` option.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return null;
}
