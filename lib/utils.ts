import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtINR(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  const s = abs.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const sign = opts.sign ? (v >= 0 ? "+" : "-") : v < 0 ? "-" : "";
  return `${sign}₹${s}`;
}

export function fmtL(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `₹${(v / 1e5).toFixed(2)} L`;
}

/**
 * Indian-style compact currency: renders K / L / Cr depending on magnitude
 * so a strip of chips ranging from ₹5K → ₹28L doesn't look ragged. Only
 * used for space-constrained UI (period-delta chips, small badges).
 */
export function fmtCompactINR(
  v: number | null | undefined,
  opts: { sign?: boolean } = {}
): string {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = opts.sign ? (v >= 0 ? "+" : "-") : v < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

export function splitL(v: number | null | undefined): { rupees: string; unit: string } {
  if (v == null || Number.isNaN(v)) return { rupees: "—", unit: "" };
  return { rupees: `₹${(v / 1e5).toFixed(2)}`, unit: "L" };
}

export function fmtPct(v: number | null | undefined, opts: { sign?: boolean; digits?: number } = {}): string {
  if (v == null || Number.isNaN(v)) return "—";
  const d = opts.digits ?? 2;
  const sign = opts.sign ? (v >= 0 ? "+" : "") : "";
  return `${sign}${v.toFixed(d)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate().toString().padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateShort(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate().toString().padStart(2, "0")} ${MONTHS[d.getMonth()]}`;
}

/**
 * IST-anchored formatters for financial dates. Groww timestamps land in
 * DB as `timestamptz` (UTC) but semantically represent Indian trading
 * calendar days — so `new Date(iso).getDate()` is timezone-fragile:
 *   • UTI order placed 2026-07-17 02:16 IST → stored as 2026-07-16 20:46Z
 *   • `.slice(0,10)` would render "16 Jul" outside IST, off by a day.
 * These helpers always evaluate the day/month in Asia/Kolkata so numbers
 * match what Groww / the AMC / your CAS statement will show.
 *
 * Date-only strings (from the `date` column, e.g. "2026-07-20") get an
 * explicit `+05:30` offset so they anchor to IST midnight rather than
 * UTC midnight (which would slide back by a day for viewers west of UTC).
 */
const IST_TZ = "Asia/Kolkata";

function toIstDate(iso: string): Date | null {
  const withTime = iso.includes("T") ? iso : `${iso}T00:00:00+05:30`;
  const d = new Date(withTime);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateShortIST(iso?: string | null): string {
  if (!iso) return "—";
  const d = toIstDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", {
    timeZone: IST_TZ,
    day: "2-digit",
    month: "short",
  });
}

export function fmtDateIST(iso?: string | null): string {
  if (!iso) return "—";
  const d = toIstDate(iso);
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", {
    timeZone: IST_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
