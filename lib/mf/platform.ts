/**
 * lib/mf/platform.ts
 *
 * Central vocabulary for the `platform` column on mf_transactions /
 * mf_contributions — WHERE an order was placed (Groww app, INDmoney
 * app, ICICI Prudential direct-AMC app, etc.), distinct from the
 * `source` column which captures the ingest mechanism.
 *
 * See migration 2026-07-24-mf-platform.sql for the full rationale on
 * why the two dimensions are stored separately, and why the vocabulary
 * lives in code (no DB CHECK constraint) so a new platform can be
 * added by editing this file alone.
 *
 * ADD A NEW PLATFORM
 * ──────────────────
 * 1. Append it to PLATFORMS below with a display label and a color
 *    key (colors are picked from the four-way palette in
 *    PLATFORM_BADGE_STYLES so we don't invite yet another arbitrary
 *    hex per addition).
 * 2. If it's an ingest path (INDmoney bulk-list, Groww paste, etc.),
 *    wire that path to pass the new PlatformCode through
 *    logMfTransaction / the equivalent write action.
 * 3. If it needs to appear in the manual-form dropdown, that's already
 *    automatic — PLATFORMS is the dropdown's source of truth.
 */

export const PLATFORMS = [
  { code: "groww", label: "Groww", color: "green" },
  { code: "indmoney", label: "INDmoney", color: "blue" },
  { code: "mfcentral", label: "MFCentral", color: "green" },
  { code: "icici_prudential", label: "ICICI Prudential", color: "amber" },
  { code: "hdfc_mf", label: "HDFC MF", color: "amber" },
  { code: "nippon_mf", label: "Nippon MF", color: "amber" },
  { code: "edelweiss_mf", label: "Edelweiss MF", color: "amber" },
  { code: "uti_mf", label: "UTI MF", color: "amber" },
  { code: "ppfas_mf", label: "PPFAS", color: "amber" },
  { code: "kotak_mf", label: "Kotak MF", color: "amber" },
  { code: "dhan", label: "Dhan", color: "blue" },
  { code: "other", label: "Other", color: "muted" },
  // Sentinel platform used ONLY by the /studio page while
  // NEXT_PUBLIC_FUNDS_TEST_MODE=true. Rows tagged with this are
  // deliberately isolated from all headline math — logMfTransaction
  // short-circuits the fund_holdings bump and the recomputeNwDaily
  // call for platform='test', so a test submit never contaminates
  // the MF card, XIRR, growth chart, or fund allocation numbers.
  // The row IS still written to mf_transactions (so the tester can
  // inspect the exact payload that would land in production) but
  // stays in that isolation until either:
  //   • NEXT_PUBLIC_FUNDS_TEST_MODE flips to false, at which point
  //     future submits use the real platform value ('indmoney' etc.)
  //   • A one-line SQL sweep purges the test corpus:
  //       DELETE FROM mf_transactions WHERE platform = 'test';
  // The "muted" colour category surfaces these as grey chips in the
  // ledger — visually distinct from real trades but not alarming.
  { code: "test", label: "TEST", color: "muted" },
] as const;

// NOTE on 'mfcentral' vs the mfcentral_cas source
// ────────────────────────────────────────────────
//   platform = 'mfcentral'      — the user actively placed the order
//                                 via MFCentral's TRANSACTING app
//                                 (MFCentral supports buy/redeem beyond
//                                 just showing the CAS statement)
//   source   = 'mfcentral_cas'  — the row was INGESTED from the
//                                 MFCentral eCAS Excel/PDF feed; the
//                                 originating platform (Groww, an AMC
//                                 site, MFCentral app itself, or any
//                                 other broker) is NOT recoverable
//                                 from the CAS payload — that's why
//                                 platform stays NULL by default for
//                                 these rows and must be user-tagged.

export type PlatformCode = (typeof PLATFORMS)[number]["code"];

/** Quick lookup: code → display label. Falls back to the raw code
 *  string for anything not in the vocabulary (defensive against
 *  legacy rows tagged with a value someone typed directly in SQL). */
const LABEL_MAP: Record<string, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p.code, p.label])
);

export function platformLabel(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return LABEL_MAP[code] ?? code;
}

/** Category buckets for coloring badges. Kept to a small palette (4
 *  colors) so adding a new platform doesn't require a new CSS class —
 *  the four categories loosely map to "broker apps" (blue),
 *  "AMC direct apps" (amber), "primary ingest" (green), and
 *  "catch-all / unknown" (muted). */
type PlatformColorKey = (typeof PLATFORMS)[number]["color"];

const COLOR_MAP: Record<string, PlatformColorKey> = Object.fromEntries(
  PLATFORMS.map((p) => [p.code, p.color])
);

/** Tailwind class strings for the platform badge in the ledger UI —
 *  same background/text pattern as OutcomeBadge & PctCell elsewhere,
 *  keyed by the color category rather than the platform code so a
 *  new platform only picks a color rather than adding a new class. */
export const PLATFORM_BADGE_STYLES: Record<PlatformColorKey | "unknown", string> = {
  green: "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]",
  blue: "bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]",
  amber: "bg-[hsl(var(--warning)/0.15)] text-[hsl(var(--warning))]",
  muted: "bg-muted/40 text-muted-foreground",
  unknown: "bg-muted/40 text-muted-foreground",
};

export function platformColorKey(
  code: string | null | undefined
): PlatformColorKey | "unknown" {
  if (!code) return "unknown";
  return COLOR_MAP[code] ?? "unknown";
}
