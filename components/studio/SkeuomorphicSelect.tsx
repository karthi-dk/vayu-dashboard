"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

const sk = {
  input: {
    background: "linear-gradient(180deg, #fdf8ee 0%, #f3e6cf 100%)",
    border: "1px solid #b29871",
    boxShadow: [
      "inset 0 2px 4px rgba(95, 66, 35, 0.16)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.65)",
    ].join(", "),
  },
  panel: {
    background: "linear-gradient(180deg, #f6efdf 0%, #eadcc2 100%)",
    border: "1px solid #bda47f",
    boxShadow: [
      "0 20px 34px -12px rgba(72, 48, 24, 0.34)",
      "0 5px 10px -3px rgba(72, 48, 24, 0.22)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
} as const;

export type SkeuomorphicSelectOption = {
  value: string;
  label: string;
};

export function SkeuomorphicSelect({
  value,
  onChange,
  options,
  placeholder = "Choose...",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SkeuomorphicSelectOption[];
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
        className="relative w-full appearance-none rounded-2xl px-4 py-3.5 pr-10 text-left text-base font-medium text-[#3f2e1a] outline-none transition-all"
        style={sk.input}
      >
        {selected ? (
          <span className="block truncate">{selected.label}</span>
        ) : (
          <span className="block truncate font-normal text-[#806346]">
            {placeholder}
          </span>
        )}
        <ChevronDown
          size={16}
          strokeWidth={2.5}
          className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#7a6242] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 right-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-2xl p-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#b08d60] [&::-webkit-scrollbar]:w-1.5"
          style={sk.panel}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlighted = i === highlighted;
            const rowCls = isSelected
              ? "bg-[#dbc39f] text-[#5f4322] font-semibold"
              : isHighlighted
                ? "bg-[#ecdcc2] text-[#4f391f]"
                : "text-[#4f391f]";
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
                  <Check
                    size={14}
                    strokeWidth={2.75}
                    className="shrink-0 text-[#6b4b28]"
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
