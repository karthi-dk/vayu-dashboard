"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * ClaymorphicSelect — themed combobox for the /studio/claymorphic
 * prototype route.
 *
 * Aesthetic language: "clay" (aka claymorphism, Michal Malewicz's
 * coinage). Signature is a chunky "3D pillow" surface with three
 * layered depth cues:
 *
 *   1. Outer drop shadow — the "resting on soft ground" cue
 *   2. Inset top highlight — the "top-lit clay puff" cue
 *   3. Inset bottom shadow — the "underside curves away" cue
 *
 * Combined, these read as a soft rubber/clay object rather than a
 * flat card. Corners are aggressively rounded (24-32px) because
 * sharp corners fight the doughy illusion.
 *
 * Trade-offs vs the other prototypes
 * ----------------------------------
 *   • More welcoming and playful than the sterile neumorphic
 *     surface — colours are saturated, shadows are more pronounced.
 *   • Denser/heavier than glassmorphism — no transparency, all
 *     surfaces are opaque solid fills. No backdrop to worry about.
 *   • Better contrast than neumorphic — dark text on white / near-
 *     white surfaces passes WCAG comfortably, no accessibility
 *     tinkering required.
 */

const cm = {
  input: {
    background: "#f0f2fa",
    boxShadow: [
      "inset 0 4px 8px 0 rgba(60, 60, 100, 0.12)",
      "inset 0 -1px 2px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
  panel: {
    background: "#ffffff",
    // Panel gets a MORE dramatic drop shadow than the card because
    // it's floating ABOVE the card. Reads as a physical object
    // popped out of the surface — the clay equivalent of an
    // elevation-2 material shadow. Amped in v2 to match the
    // amped depth of the form card itself; a subdued panel would
    // look wrong hovering above a chunkier card.
    boxShadow: [
      "0 30px 50px -10px rgba(60, 60, 100, 0.30)",
      "0 12px 20px -4px rgba(60, 60, 100, 0.12)",
      "inset 0 8px 12px -4px rgba(255, 255, 255, 1)",
      "inset 0 -6px 10px -4px rgba(60, 60, 100, 0.06)",
    ].join(", "),
  },
} as const;

export type ClaymorphicSelectOption = {
  value: string;
  label: string;
};

export function ClaymorphicSelect({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ClaymorphicSelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlighted(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

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
        className="relative w-full appearance-none rounded-2xl px-4 py-3.5 pr-10 text-left text-base font-medium text-slate-800 outline-none transition-all"
        style={cm.input}
      >
        {selected ? (
          <span className="block truncate">{selected.label}</span>
        ) : (
          <span className="block truncate font-normal text-slate-400">
            {placeholder}
          </span>
        )}
        <ChevronDown
          size={16}
          strokeWidth={2.5}
          className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 right-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-3xl p-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar]:w-1.5"
          style={cm.panel}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlighted = i === highlighted;
            const rowCls = isSelected
              ? "bg-violet-100 text-violet-700 font-semibold"
              : isHighlighted
                ? "bg-slate-100 text-slate-800"
                : "text-slate-700";
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
                className={`flex cursor-pointer items-center justify-between rounded-2xl px-3 py-2.5 text-sm transition-colors ${rowCls}`}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && (
                  <Check
                    size={14}
                    strokeWidth={3}
                    className="shrink-0 text-violet-600"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
