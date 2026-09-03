import Link from "next/link";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip } from "@/components/ui/Tooltip";
import { MobileNav } from "./MobileNav";
import { NavLinks } from "./NavLinks";
import { DesktopNavActions } from "./DesktopNavActions";
import { RefreshAllButton } from "./RefreshAllButton";
import { sbServer as sb } from "@/lib/supabase";

type NavFundRow = {
  fund_code: string;
  fund_name: string;
  nav_date: string | null;
  nav_source: string | null;
};

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

async function mfFreshStaleSummary(): Promise<{
  headlineNavDate: string | null;
  fresh: NavFundRow[];
  stale: NavFundRow[];
  fallback: NavFundRow[];
  total: number;
}> {
  const { data, error } = await sb
    .from("fund_holdings")
    .select("fund_code,fund_name,nav_date,nav_source")
    .order("fund_code", { ascending: true });
  if (error || !data || data.length === 0) {
    return { headlineNavDate: null, fresh: [], stale: [], fallback: [], total: 0 };
  }

  const rows = data as NavFundRow[];
  const freq = new Map<string, number>();
  for (const r of rows) {
    if (!r.nav_date) continue;
    freq.set(r.nav_date, (freq.get(r.nav_date) ?? 0) + 1);
  }

  let headlineNavDate: string | null = null;
  let bestCount = 0;
  for (const [d, count] of freq.entries()) {
    if (
      count > bestCount ||
      (count === bestCount && (headlineNavDate === null || d > headlineNavDate))
    ) {
      headlineNavDate = d;
      bestCount = count;
    }
  }

  if (!headlineNavDate) {
    return { headlineNavDate: null, fresh: [], stale: [], fallback: [], total: rows.length };
  }

  const fresh = rows.filter((r) => r.nav_date === headlineNavDate);
  const stale = rows.filter(
    (r) => r.nav_date != null && r.nav_date < headlineNavDate
  );
  // Funds whose latest NAV came from the mfapi fallback rather than the
  // AMFI primary. A couple (overseas T+1) is normal; the whole batch
  // means AMFI's feed failed — see refresh-mf-nav's amfi_fallback_reason.
  const fallback = rows.filter((r) => r.nav_source === "mfapi");
  return { headlineNavDate, fresh, stale, fallback, total: rows.length };
}

/**
 * Absolute NAV age vs today (IST). Fresh/Stale only compares funds to each
 * other; this catches the whole batch trailing today (holiday/weekend or a
 * missed refresh). weekdayLag counts Mon–Fri strictly after navDate up to
 * today: 0–1 is normal (today's NAV just hasn't published), ≥2 means behind.
 */
function navAgeInfo(navDateIso: string | null): {
  label: string | null;
  daysOld: number;
  lagging: boolean;
} {
  if (!navDateIso) return { label: null, daysOld: 0, lagging: false };
  const DAY = 86_400_000;
  const istNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const today = Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
  const [y, m, d] = navDateIso.split("-").map(Number);
  const navUtc = Date.UTC(y, m - 1, d);
  const daysOld = Math.max(0, Math.round((today - navUtc) / DAY));
  let weekdayLag = 0;
  for (let t = navUtc + DAY; t <= today; t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdayLag++;
  }
  const label = new Date(navUtc).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  return { label, daysOld, lagging: weekdayLag >= 2 };
}

export async function TopNav() {
  const [lastSync, lastNav, mfSummary] = await Promise.all([
    latestHoldingsSync(),
    latestNavRefresh(),
    mfFreshStaleSummary(),
  ]);
  const navAge = navAgeInfo(mfSummary.headlineNavDate);
  // Whole batch off AMFI = the primary feed failed (silent before this).
  const fullFallback =
    mfSummary.total > 0 && mfSummary.fallback.length === mfSummary.total;
  return (
    <header className="sticky top-0 z-40 overflow-visible border-b border-border bg-background/80 backdrop-blur">
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
              dotColor={
                navAge.lagging || fullFallback
                  ? "warning"
                  : lastNav
                    ? "success"
                    : "warning"
              }
              tooltip={
                <div className="min-w-[230px] space-y-1">
                  <div className="font-medium">NAVs</div>
                  <div className="opacity-80">
                    Checked{" "}
                    {lastNav
                      ? new Date(lastNav).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "never"}
                  </div>
                  {navAge.label && (
                    <div className="opacity-80">
                      NAV dated{" "}
                      <span className="font-medium">{navAge.label}</span>
                      {navAge.daysOld > 0 &&
                        ` · ${navAge.daysOld} day${
                          navAge.daysOld === 1 ? "" : "s"
                        } old`}
                    </div>
                  )}
                  {navAge.lagging && (
                    <div className="rounded border border-[hsl(var(--warning)/0.42)] bg-[hsl(var(--warning)/0.14)] px-2 py-1 text-[10px] leading-snug text-[hsl(var(--warning))]">
                      Latest NAV is {navAge.daysOld} days old — usually a market
                      holiday/weekend, but if it persists on a trading day the
                      NAV source may be lagging. Try the refresh icon.
                    </div>
                  )}
                  {mfSummary.headlineNavDate && (
                    <div className="rounded border border-border/40 bg-background/25 p-2 text-[10px] leading-snug">
                      <div className="rounded border border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.12)] px-2 py-1 text-[hsl(var(--success))]">
                        <span className="font-semibold">
                          <span
                            aria-hidden="true"
                            className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--success))] align-middle"
                          />
                          On latest ({mfSummary.fresh.length})
                        </span>{" "}
                        <span className="font-medium">
                          {mfSummary.fresh.map((f) => f.fund_code).join(", ")}
                        </span>
                      </div>
                      {mfSummary.stale.length > 0 && (
                        <div className="mt-1 rounded border border-[hsl(var(--warning)/0.42)] bg-[hsl(var(--warning)/0.14)] px-2 py-1 text-[hsl(var(--warning))]">
                          <span className="font-semibold">
                            <span
                              aria-hidden="true"
                              className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--warning))] align-middle"
                            />
                            Behind ({mfSummary.stale.length})
                          </span>{" "}
                          <span className="font-medium">
                            {mfSummary.stale
                              .map((f) =>
                                `${f.fund_code}${f.nav_date ? `(${new Date(f.nav_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })})` : ""}`
                              )
                              .join(", ")}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {mfSummary.fallback.length > 0 && (
                    <div className="rounded border border-[hsl(var(--warning)/0.42)] bg-[hsl(var(--warning)/0.14)] px-2 py-1 text-[10px] leading-snug text-[hsl(var(--warning))]">
                      <span className="font-semibold">
                        <span
                          aria-hidden="true"
                          className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--warning))] align-middle"
                        />
                        Via mfapi fallback ({mfSummary.fallback.length})
                      </span>{" "}
                      <span className="font-medium">
                        {mfSummary.fallback.map((f) => f.fund_code).join(", ")}
                      </span>
                      <div className="mt-0.5 opacity-90">
                        {fullFallback
                          ? "AMFI served nothing — its feed likely failed; prices may lag."
                          : "AMFI didn't have these yet — usually the T+1 overseas window."}
                      </div>
                    </div>
                  )}
                  <div className="opacity-60">
                    Checked = when we last fetched. NAV dated = the day the
                    prices are for. On latest = funds on the newest NAV;
                    Behind = funds trailing it (FoF / international, T+2).
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
          <DesktopNavActions />
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
  dotColor,
}: {
  label: string;
  isoDate: string | null;
  tooltip: React.ReactNode;
  dotColor?: "success" | "warning";
}) {
  return (
    <Tooltip content={tooltip} side="bottom" align="end">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground sm:gap-1.5 sm:text-xs">
        <PulseDot color={dotColor ?? (isoDate ? "success" : "warning")} />
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
        <span className="whitespace-nowrap">
          <TimeAgo isoDate={isoDate} />
        </span>
      </div>
    </Tooltip>
  );
}
