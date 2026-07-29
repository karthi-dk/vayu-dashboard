"use client";

import { useEffect } from "react";
import { playClick, unlockAudio } from "@/lib/studio/sounds";

/**
 * StudioClickSound — mounts a single document-level listener that
 * plays the tactile click sound for EVERY commit-style user gesture
 * inside `/studio`: dropdown taps, option picks, date picker commits,
 * amount ladder buttons, timeframe pills, Submit, Skip, Back, Replay.
 *
 * WHY GLOBAL, NOT PER-BUTTON
 * ───────────────────────────
 * Sprinkling `onClick={playClick}` on every button (a) is repetitive
 * and easy to forget, (b) misses interactions we don't own (native
 * `<select>` option picks, `<input type="date">` value commits), and
 * (c) breaks the "one wire, works everywhere" promise. A single
 * capture-phase document listener catches every trusted user gesture,
 * present and future, without touching individual components.
 *
 * WHAT COUNTS AS A "TAP"
 * ──────────────────────
 * TRUE  — click on: button, [role="button"], select, a[href],
 *         input[type="radio"|"checkbox"|"submit"|"date"|"time"|"button"|"reset"],
 *         label (which forwards to its input),
 *         option (desktop dropdown option pick).
 * TRUE  — change on: select, input[type="date"|"time"] — fires when
 *         the OS native picker commits a value on mobile (where the
 *         option pick isn't a DOM click event we can hear).
 * FALSE — click on any text-family input (user is focusing to type).
 * FALSE — untrusted events (event.isTrusted === false, i.e., .click()
 *         called from JS — we only sound for real user gestures).
 * FALSE — clicks landing on the page background / scroll surface.
 *
 * THROTTLE (60ms)
 * ───────────────
 * Native form controls can fire multiple synthetic events per real
 * user gesture (mousedown + mouseup + click, or click + change).
 * A 60ms guard collapses those bursts into a single audible tap so
 * a single dropdown selection sounds like one tap, not a rapid-fire
 * three-click clatter. 60ms is short enough that two DELIBERATE
 * rapid taps (e.g., double-clicking the amount ladder) still sound
 * distinct.
 *
 * ACCESSIBILITY
 * ─────────────
 * Sound respect for `prefers-reduced-motion: reduce` is handled inside
 * `playClick()` itself — no need to gate at the listener layer.
 *
 * LIFECYCLE
 * ─────────
 * Renders nothing. Mounts on `/studio` entry, unmounts on route
 * exit. Effect cleanup removes the listeners so we don't leak
 * document-level handlers when the user navigates away.
 */
export function StudioClickSound(): null {
  useEffect(() => {
    /** Selectors for elements whose click should tap. `label` is
     *  included because a click on a label forwards to its input;
     *  the label click is often what the user actually taps on
     *  form rows with wide hit targets. */
    const CLICKABLE_SELECTOR = [
      "button",
      '[role="button"]',
      "select",
      "a[href]",
      // Native <option> tag AND the ARIA equivalent. The role
      // variant catches list items inside our custom themed
      // dropdowns (Neumorphic/Glassmorphic/Claymorphic Select
      // components render options as <li role="option"> since
      // the native <option> can't be styled) — without this
      // rule, picking an option in those dropdowns wouldn't
      // fire the click sound.
      "option",
      '[role="option"]',
      // Other ARIA-only interactive roles worth catching for
      // future themed components (menu items, tabs, radios,
      // etc.) — free future-proofing at no runtime cost.
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

    /** Text-family input types that should NEVER tap on click —
     *  the user is focusing to type, not committing an action. */
    const TEXT_INPUT_TYPES = new Set([
      "text",
      "number",
      "tel",
      "email",
      "url",
      "search",
      "password",
    ]);

    // Sliding-window throttle: at most one tap every 60ms. Guards
    // against click+change duplication and against native controls
    // synthesising rapid event bursts.
    let lastTapAt = 0;
    const THROTTLE_MS = 60;
    const tap = () => {
      const now = performance.now();
      if (now - lastTapAt < THROTTLE_MS) return;
      lastTapAt = now;
      playClick();
    };

    const onClick = (e: Event) => {
      // Only real user gestures — `isTrusted` is false for synthetic
      // clicks (e.g., `button.click()` called from JS or React
      // testing library). We don't want animations to accidentally
      // trigger sounds.
      if (!(e as MouseEvent).isTrusted) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Text-family <input> or <textarea> or contenteditable:
      // clicking to focus should not sound.
      if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) {
        return;
      }
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        target.isContentEditable
      ) {
        return;
      }
      // Walk up to find the closest interactive ancestor. This lets
      // a click on the <span> inside a <button>Submit</span></button>
      // still tap — you clicked the button's content, which counts.
      const clickable = target.closest(CLICKABLE_SELECTOR);
      if (!clickable) return;
      // If the clickable ITSELF is a text input (e.g. clicked directly
      // on an <input type="text">), skip. `.closest` matches the
      // element itself so this guard catches the fallthrough case
      // where the target is a text input wrapped in a label.
      if (clickable instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(clickable.type)) {
        return;
      }
      // First-ever click also unlocks audio (mobile browsers require
      // AudioContext.resume() inside a gesture handler). unlockAudio
      // is idempotent — no-op after the first successful resume.
      void unlockAudio();
      tap();
    };

    /** Change listener — catches OS native picker commits on mobile
     *  where the option pick isn't a DOM click. `<select>` and date
     *  inputs are the main cases; the browser fires `change` when
     *  the picker sheet closes with a new value. */
    const onChange = (e: Event) => {
      if (!(e as Event & { isTrusted?: boolean }).isTrusted) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const isPickerCommit =
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement &&
          ["date", "time", "datetime-local", "month", "week", "color", "file", "range"].includes(
            target.type
          ));
      if (!isPickerCommit) return;
      tap();
    };

    // Capture phase so we run BEFORE component-level click handlers.
    // In practice it doesn't matter for the sound (handlers can't
    // prevent us from playing), but capture makes the ordering
    // predictable — the sound fires the moment the tap is registered.
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
    };
  }, []);

  return null;
}
