import Link from "next/link";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip } from "@/components/ui/Tooltip";
import { MobileNav } from "./MobileNav";
import { NavLinks } from "./NavLinks";
import { RefreshAllButton } from "./RefreshAllButton";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import { sbServer as sb } from "@/lib/supabase";

/**
 * TWO FRESHNESS INDICATORS
 * ------------------------
 * The nav shows a pair of "X ago" chips instead of just one, because
 * "sync" isn't a single concept:
 *
 *   • HOLDINGS sync — did the STRUCTURE of the portfolio change? Units,
 *     invested amounts, holding-level breakdowns. Bumped by Groww paste
 *     and per-fund Dhan resyncs.
 *
 *   • NAV sync — did the PRICE tick? Just NAVs, no units. Bumped by
 *     the daily 6am IST cron (or manual click of the refresh icon).
 *
 * Merging them would erase the "your holdings are stale" signal — the
 * daily NAV cron would always keep the timestamp fresh even when the
 * user hasn't pasted Groww in weeks. Splitting keeps both signals
 * usable independently.
 */

async function latestHoldingsSync(): Promise<string | null> {
  // Reads three parallel queries and returns the max:
  //   fund_holdings.updated_at              → Groww paste
  //   fund_holdings_detail.extracted_at     → Dhan fund resync
  //   fund_non_security_holdings.extracted_at → Dhan fund resync (non-security)
  const [fh, fhd, fnsh] = await Promise.all([
    sb.from("fund_holdings").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("fund_holdings_detail").select("extracted_at").order("extracted_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("fund_non_security_holdings").select("extracted_at").order("extracted_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const candidates = [
    (fh.data as { updated_at: string } | null)?.updated_at,
    (fhd.data as { extracted_at: string } | null)?.extracted_at,
    (fnsh.data as { extracted_at: string } | null)?.extracted_at,
  ].filter((v): v is string => Boolean(v));
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}

async function latestNavRefresh(): Promise<string | null> {
  // Reads two parallel queries and returns the max:
  //   fund_holdings.nav_updated_at → MF NAV refresh (mfapi.in daily / Groww)
  //   nps_state.nav_updated_at     → NPS NAV refresh (Kotak daily / CAS paste)
  // Note: CAS paste and Groww paste ALSO write nav_updated_at, so this
  // indicator will bump on those events too — that's fine, they're
  // legitimate NAV refresh paths (just user-initiated ones).
  const [fh, nps] = await Promise.all([
    sb
      .from("fund_holdings")
      .select("nav_updated_at")
      .order("nav_updated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from("nps_state")
      .select("nav_updated_at")
      .eq("id", 1)
      .maybeSingle(),
  ]);
  const candidates = [
    (fh.data as { nav_updated_at: string | null } | null)?.nav_updated_at,
    (nps.data as { nav_updated_at: string | null } | null)?.nav_updated_at,
  ].filter((v): v is string => Boolean(v));
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}

export async function TopNav() {
  const [lastSync, lastNav] = await Promise.all([
    latestHoldingsSync(),
    latestNavRefresh(),
  ]);
  return (
    <header className="sticky top-0 z-40 overflow-x-hidden border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4 sm:gap-8">
          <Link
            href="/"
            className="shrink-0 text-sm font-bold tracking-tight text-foreground"
          >
            VAYU<span className="text-[hsl(var(--primary))]">.</span>
          </Link>
          <NavLinks />
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          {/* Two freshness chips — Holdings and NAVs.
              Responsive layout is the interesting bit:
                • Mobile (< sm): STACKED VERTICALLY, dot + short time
                  ("● 4m ago"), 10px text, no labels. Fits the nav
                  height of 56px comfortably in two rows.
                • Desktop (≥ sm): SIDE-BY-SIDE, dot + label + time
                  ("● Holdings 4m ago · ● NAVs 6h ago"), 12px text,
                  bullet separator.
              Labels move into the tooltip on mobile so nothing is
              actually hidden — same info, gated on hover/tap.
              Custom Tooltip (75ms show) replaces browser native title
              (~800ms). Matches the refresh icon's tooltip UX. */}
          <div className="flex flex-col items-end gap-0 leading-tight sm:flex-row sm:items-center sm:gap-2 sm:leading-normal">
            <FreshnessChip
              label="Holdings"
              isoDate={lastSync}
              tooltip={
                <div className="min-w-[220px] space-y-1">
                  <div className="font-medium">Holdings synced</div>
                  <div className="opacity-80">
                    {lastSync
                      ? new Date(lastSync).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "Not synced yet"}
                  </div>
                  <div className="opacity-60">
                    Resets on Groww paste or Dhan fund resync. Tells you
                    if your units and invested amounts are current.
                  </div>
                </div>
              }
            />
            {/* Bullet separator — visible only on horizontal (sm+)
                layout. Kept inside the same wrapper so it participates
                in the same flex row. On stacked mobile layout the
                bullet would just be visual noise. */}
            <span
              className="hidden text-muted-foreground/40 sm:inline"
              aria-hidden="true"
            >
              ·
            </span>
            <FreshnessChip
              label="NAVs"
              isoDate={lastNav}
              tooltip={
                <div className="min-w-[220px] space-y-1">
                  <div className="font-medium">NAVs refreshed</div>
                  <div className="opacity-80">
                    {lastNav
                      ? new Date(lastNav).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "Not refreshed yet"}
                  </div>
                  <div className="opacity-60">
                    Resets on the daily 6am IST cron or a click of the
                    refresh icon. Tells you if your prices (and 1D
                    deltas) are current.
                  </div>
                </div>
              }
            />
          </div>
          {/* One-click MF + NPS NAV refresh — same endpoints as the
              Sync page card, just always-visible. See
              components/nav/RefreshAllButton.tsx for the design
              rationale on why this lives in TopNav rather than
              only on the Overview page. */}
          <RefreshAllButton />
          {/* Theme + sign-out live in the mobile sheet below md so
              the phone header stays: brand · chips · refresh · menu. */}
          <div className="hidden items-center gap-1.5 md:flex">
            <ThemeToggle />
            <SignOutButton />
          </div>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

/**
 * Single freshness chip — colored dot + label + relative time.
 *
 * Responsive rules:
 *   • Mobile (< sm): 10px text, label hidden (into tooltip), tight
 *     4px gap. Two chips stacked vertically fit in the 56px nav
 *     height comfortably. Timestamps like "4m ago" / "6h ago" stay
 *     legible at this size.
 *   • Desktop (≥ sm): 12px text, full "Label {time}" shown, 6px gap.
 *
 * The chip itself is the tooltip trigger — hovering anywhere on it
 * (dot, label, time) shows the tooltip. Uses the shared Tooltip
 * component for the 75ms show delay (vs ~800ms native title).
 */
function FreshnessChip({
  label,
  isoDate,
  tooltip,
}: {
  label: string;
  isoDate: string | null;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip} side="bottom" align="end">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground sm:gap-1.5 sm:text-xs">
        <PulseDot color={isoDate ? "success" : "warning"} />
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
        <span className="whitespace-nowrap">
          <TimeAgo isoDate={isoDate} />
        </span>
      </div>
    </Tooltip>
  );
}
