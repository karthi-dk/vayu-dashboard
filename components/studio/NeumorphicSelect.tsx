"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * NeumorphicSelect — custom combobox for the /studio/neumorphic
 * prototype route.
 *
 * Why not native <select>?
 * ------------------------
 * Native <select> dropdown PANELS (the popup with <option> rows)
 * are rendered by the OS/browser and can't be themed — they always
 * fall back to system whites, system blue selection highlights,
 * system fonts. That's fine on production /studio where the design
 * note is "let the OS handle it, mobile users get haptics for
 * free". But the whole point of the neumorphic prototype is to
 * evaluate the full soft-pastel aesthetic, and a jarring
 * system-blue selection strip in the middle of the flow breaks the
 * illusion in a way screenshots would call out immediately.
 *
 * Trade-offs vs native
 * --------------------
 *   • Loses OS-level mobile pickers (fullscreen wheels on iOS,
 *     bottom sheets on Android) — a real usability regression on
 *     phones. If neumorphic wins the vote, we'd revisit whether to
 *     keep custom on desktop + swap to native on mobile via
 *     coarse-pointer media query.
 *   • Adds ~120 LoC of a11y handling (keyboard nav, ARIA roles,
 *     click-outside, escape, focus). Kept minimal here — full
 *     Radix/Combobox-quality a11y is overkill for a prototype.
 *   • Panel measures its trigger's box width via CSS (absolute
 *     left-0 right-0) so it always matches even with flex-1
 *     siblings. Doesn't attempt to flip above when overflowing
 *     viewport — /studio's short scroll makes this a non-issue.
 *
 * Keyboard model
 * --------------
 *   Closed:  Space / Enter / ArrowDown → open panel, focus at
 *            currently-selected option
 *   Open:    ArrowUp/Down → move highlight
 *            Enter        → commit + close
 *            Escape       → close without committing
 *            Tab          → close (native tab-out behaviour)
 *   Any:     click outside → close (mousedown-driven)
 */

// Neumorphic shadow tokens — duplicated from
// NeumorphicOrderEntryLanding intentionally so this component is
// self-contained. If we promote the design out of prototype, both
// files' `nm` should be extracted to a lib/neumorphic module.
const nm = {
  raisedMd: {
    boxShadow: "-8px -8px 16px #ffffff, 8px 8px 16px #a3b1c6",
  },
  inset: {
    boxShadow: "inset 4px 4px 8px #a3b1c6, inset -4px -4px 8px #ffffff",
  },
} as const;

export type NeumorphicSelectOption = {
  value: string;
  label: string;
};

export function NeumorphicSelect({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: NeumorphicSelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // -1 sentinel means "no highlight yet"; the openEffect below
  // resets this to the currently-selected index whenever the panel
  // opens, so keyboard nav starts from the user's current choice.
  const [highlighted, setHighlighted] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  // Click-outside → close. Uses mousedown (not click) for immediate
  // response before the target element's own click handler fires,
  // which matters if the user is bouncing between two adjacent
  // selects — the second trigger's click should close-then-open
  // cleanly rather than double-toggling.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // On open, jump the highlight to the currently-selected option
  // so keyboard nav has a sensible starting point. Falls back to
  // index 0 for the "no selection yet" case (e.g. Fund on first
  // load — value === "").
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlighted(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  // Auto-scroll the highlighted option into the visible panel area
  // whenever it changes via keyboard nav. block:"nearest" scrolls
  // only enough to bring the item into view — no jarring recenter.
  useEffect(() => {
    if (!open || highlighted < 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[highlighted];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKey}
        className="relative w-full appearance-none rounded-2xl bg-[#e0e5ec] px-4 py-3 pr-10 text-left text-base text-[#4a5568] outline-none transition-all"
        style={nm.inset}
      >
        {selected ? (
          <span className="block truncate">{selected.label}</span>
        ) : (
          <span className="block truncate text-[#a6b0c0]">{placeholder}</span>
        )}
        <ChevronDown
          size={14}
          className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#8a94a7] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 right-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-2xl bg-[#e0e5ec] p-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#b8c0d0] [&::-webkit-scrollbar]:w-1.5"
          style={nm.raisedMd}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlighted = i === highlighted;
            // Layered visual states:
            //   1. Selected wins the strongest tint (soft-indigo
            //      wash echoing the CTA colour).
            //   2. Highlighted (keyboard focus / mouse hover) gets
            //      a mid-tone bg to communicate "you're here".
            //   3. Default is transparent — the whole panel is on
            //      the raised neumorphic surface, no extra fill.
            const rowCls = isSelected
              ? "bg-[#c9d0e8] text-[#5665b8] font-medium"
              : isHighlighted
                ? "bg-[#d5dae2] text-[#4a5568]"
                : "text-[#4a5568]";
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-colors ${rowCls}`}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && (
                  <Check size={14} className="shrink-0 text-[#5665b8]" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
