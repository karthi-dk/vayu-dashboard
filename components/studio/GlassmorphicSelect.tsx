"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * GlassmorphicSelect — themed combobox for the /studio/glassmorphic
 * prototype route.
 *
 * Same "native <select> panels are un-styleable" rationale as
 * NeumorphicSelect. The visual language is different: instead of
 * soft-pastel extrusion, we render frosted-glass surfaces over the
 * aurora gradient. Backdrop-filter blur + saturate boost is the
 * signature — it lets the vivid violet/pink/blue backdrop bleed
 * through the trigger and panel, which is what makes
 * glassmorphism read as "glass" rather than "white box".
 *
 * Text/icon contrast on translucent surfaces is the hard part —
 * we lean on white text with opacity variants (60% muted, 40%
 * placeholder) so hierarchy is clear without needing hard fills
 * that would fight the glass effect.
 */

const gm = {
  input: {
    background: "rgba(255, 255, 255, 0.08)",
    backdropFilter: "blur(12px) saturate(180%)",
    WebkitBackdropFilter: "blur(12px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.15)",
  },
  // Popover panel — layered fill for maximum content occlusion
  // without giving up the glass character.
  //
  //   Iteration 1 (10% white): pure card-tier — fields bled
  //                             through, unusable.
  //   Iteration 2 (72% indigo): still too transparent; the card
  //                             underneath is 10% glass so 28%
  //                             bleed compounded with card
  //                             transparency = fields still
  //                             readable through panel.
  //   Iteration 3 (this): TWO stacked backgrounds — a mostly-
  //                       opaque dark base (92% slate) sits
  //                       under a subtle aurora-tint wash to
  //                       preserve the "glass" character. The
  //                       backdrop-filter still runs so the
  //                       edges near the borders sample colour
  //                       from behind, but the content is
  //                       properly obscured.
  //
  // Apple's "vibrant dark thick" material sits ~88-95% opaque —
  // this matches the upper end of that spec.
  panel: {
    background:
      "linear-gradient(rgba(139, 92, 246, 0.08), rgba(59, 130, 246, 0.08)), rgba(15, 15, 30, 0.92)",
    backdropFilter: "blur(30px) saturate(180%)",
    WebkitBackdropFilter: "blur(30px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.20)",
    boxShadow: "0 20px 50px 0 rgba(0, 0, 0, 0.55)",
  },
} as const;

export type GlassmorphicSelectOption = {
  value: string;
  label: string;
};

export function GlassmorphicSelect({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: GlassmorphicSelectOption[];
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
        className="relative w-full appearance-none rounded-2xl px-4 py-3 pr-10 text-left text-base text-white outline-none transition-all"
        style={gm.input}
      >
        {selected ? (
          <span className="block truncate">{selected.label}</span>
        ) : (
          <span className="block truncate text-white/40">{placeholder}</span>
        )}
        <ChevronDown
          size={14}
          className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/60 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 right-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-2xl p-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar]:w-1.5"
          style={gm.panel}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlighted = i === highlighted;
            // Selected wins the accent tint. Highlighted gets a
            // stronger glass fill. Default rows are transparent —
            // the panel's underlying blur already sets the visual
            // separation, no per-row fill needed.
            const rowCls = isSelected
              ? "bg-fuchsia-300/25 text-white font-medium ring-1 ring-inset ring-fuchsia-300/40"
              : isHighlighted
                ? "bg-white/15 text-white"
                : "text-white/85";
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
                  <Check size={14} className="shrink-0 text-fuchsia-200" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
