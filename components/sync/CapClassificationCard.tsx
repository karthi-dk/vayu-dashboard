"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RefreshCw, Building2, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  CapDetailModal,
  type CapBucketDescriptor,
} from "@/components/sync/CapDetailModal";
import type { SyncData } from "@/lib/queries";

type Props = { data: SyncData["capClassification"] };

// Static per-tile metadata. The description is what shows up in the
// modal header — small enough to write out once here rather than
// derive at runtime. `refreshTouches` says whether the Refresh button
// will actually update this bucket — used to explain to the user why
// clicking Refresh doesn't move US numbers (they're a one-shot
// backfill, not a Nifty-driven sync).
//
// Large is intentionally split into two tiles (N50 = mega-caps,
// NN50 = rank 51-100). Both count as 100 % Large in the look-through
// cap allocation (2026-07-27 convention change) — the visual split
// still exists so we can see at a glance whether a user's Large
// exposure sits in mega-caps vs the 51-100 tier.
const BUCKET_META: Record<
  TileKey,
  {
    dotColor: string;
    kicker: string;
    title: string;
    description: string;
    region: "India" | "US";
    refreshTouches: boolean;
    /** Label shown ON the tile. Kept short so tiles don't wrap. */
    tileLabel: string;
  }
> = {
  LargeN50: {
    dotColor: "hsl(var(--success))",
    kicker: "India · Large / N50",
    title: "Nifty 50",
    description:
      "India equities in the Nifty 50 index — top 50 by full-float market cap. Refresh syncs from NSE's ind_nifty50list.csv. mcap_classification=Large, source=nse-nifty50.",
    region: "India",
    refreshTouches: true,
    tileLabel: "LARGE · N50",
  },
  LargeNN50: {
    // Slightly muted green vs N50 so the two Large tiles read as
    // related but distinct — same tier, different sub-index.
    dotColor: "hsl(150 55% 50%)",
    kicker: "India · Large / Nifty Next 50",
    title: "Nifty Next 50",
    description:
      "India equities ranked 51–100 by market cap. Counted as 100% Large in Vayu's cap allocation (2026-07-27 convention). Refresh syncs from NSE's ind_niftynext50list.csv. mcap_classification=Large, source=nse-niftynext50.",
    region: "India",
    refreshTouches: true,
    tileLabel: "LARGE · NN50",
  },
  LargeOverride: {
    // Third green in the Large family — dimmer/greyer than NN50 so
    // the eye reads "Large tier, but not from an NSE index CSV".
    // This bucket is intentionally small; if it grows past ~10 it's
    // usually a signal that a Nifty rebalance CSV parse silently
    // dropped rows and manual overrides are compensating.
    dotColor: "hsl(150 20% 55%)",
    kicker: "India · Large / manual override",
    title: "Large — manual override",
    description:
      "India equities tagged Large by scripts/set-cap-override.mjs (or a legacy source string) rather than an NSE index CSV. Used for demerger entities, spin-offs, and newly-listed stocks not yet in Nifty 50 / Next 50. Kept separate from N50/NN50 so those counts match NSE exactly (50 stocks each by index definition). Refresh doesn't touch these rows — clear the override with `--clear` to make them eligible again.",
    region: "India",
    refreshTouches: false,
    tileLabel: "LARGE · OVR",
  },
  Mid: {
    dotColor: "hsl(var(--primary))",
    kicker: "India · Mid cap",
    title: "Nifty Midcap 150",
    description:
      "India equities ranked 101–250 by market cap. Refresh syncs from NSE's ind_niftymidcap150list.csv.",
    region: "India",
    refreshTouches: true,
    tileLabel: "MID",
  },
  Small: {
    dotColor: "hsl(var(--warning))",
    kicker: "India · Small cap",
    title: "Nifty Smallcap 250",
    description:
      "India equities ranked 251–500 by market cap. Refresh syncs from NSE's ind_niftysmallcap250list.csv.",
    region: "India",
    refreshTouches: true,
    tileLabel: "SMALL",
  },
  Micro: {
    dotColor: "hsl(var(--warning))",
    kicker: "India · Micro cap",
    title: "Nifty Microcap 250",
    description:
      "India equities ranked 501–750 by market cap. Refresh syncs from NSE's ind_niftymicrocap250_list.csv.",
    region: "India",
    refreshTouches: true,
    tileLabel: "MICRO",
  },
  Nano: {
    dotColor: "hsl(var(--danger))",
    kicker: "India · Nano cap",
    title: "Nano cap",
    description:
      "NSE-listed equities not in any of the four Nifty size indices — the long tail beyond rank 750. Sourced from NSE's EQUITY_L.csv.",
    region: "India",
    refreshTouches: true,
    tileLabel: "NANO",
  },
  US: {
    dotColor: "hsl(280 65% 60%)",
    kicker: "US equities",
    title: "US",
    description:
      "US equities held via international MFs. All classified as \"US\"; S&P 500 / Nasdaq 100 detail lives in the Index column. One-shot backfill from iShares — Refresh button doesn't touch this bucket.",
    region: "US",
    refreshTouches: false,
    tileLabel: "US",
  },
};

const ORDERED_KEYS: TileKey[] = [
  "LargeN50",
  "LargeNN50",
  "LargeOverride",
  "Mid",
  "Small",
  "Micro",
  "Nano",
  "US",
];

type Move = {
  isin: string;
  symbol: string | null;
  from: string | null;
  to: "Large" | "Mid" | "Small" | "Micro" | "Nano";
  fromSub: "N50" | "NN50" | null;
  toSub: "N50" | "NN50" | null;
};

type RefreshResponse =
  | {
      ok: true;
      fetchedAt: string;
      elapsedMs: number;
      sourceCounts: {
        n50: number;
        nn50: number;
        large: number;
        mid: number;
        small: number;
        micro: number;
        universe: number;
      };
      counts: {
        Large: number;
        Mid: number;
        Small: number;
        Micro: number;
        Nano: number;
      };
      subCounts: { N50: number; NN50: number; Override: number };
      moves: Move[];
      movesCount: number;
      /** Rows whose classification stayed the same but whose source
       *  string was migrated to the canonical `nse-*` tag. Post-first
       *  Refresh it's typically 0 — surfaced as a quiet footer so the
       *  initial ~2000-row normalisation isn't scary. */
      sourceNormalizedCount: number;
      /** Rows skipped because their `confidence` marks them as a sticky
       *  manual override (e.g. demerger entities not yet in NSE index
       *  CSVs). Counted under their current bucket but never reclassified. */
      manualOverridesPreserved: number;
      /** Manual overrides auto-cleared during this sweep because NSE
       *  has caught up (classifier's tier + sub-bucket now match the
       *  pin's declared classification). Only `confidence` was
       *  rewritten — mcap and source stay identical. Future refreshes
       *  will reclassify these rows normally. */
      autoClearedOverrides: {
        isin: string;
        symbol: string | null;
        bucket: "Large" | "Mid" | "Small" | "Micro" | "Nano";
        subBucket: "N50" | "NN50" | null;
      }[];
      autoClearedOverridesCount: number;
      outsideCount: number;
    }
  | {
      ok: false;
      stage?: string;
      error?: string;
      bucket?: string;
    };

type TileKey =
  | "LargeN50"
  | "LargeNN50"
  | "LargeOverride"
  | "Mid"
  | "Small"
  | "Micro"
  | "Nano"
  | "US";

/**
 * Cap-classification refresh card
 * ================================
 *
 * Manual button that (a) fetches the 4 Nifty index CSVs + NSE
 * EQUITY_L, (b) rewrites every India-equity row's
 * mcap_classification, (c) shows the diff.
 *
 * WHY MANUAL, NOT CRON
 * --------------------
 * Nifty rebalances are semi-annual (Mar/Sep) plus 3-5 ad-hoc
 * mid-cycle changes per year. A daily cron would mostly no-op and
 * silently move a handful of stocks between segments — hard to
 * spot and easy to miss. Manual with a clear diff summary is the
 * right call for an inherently discrete event.
 *
 * DIFF PRESENTATION
 * -----------------
 * Success state shows:
 *   • 5 tile counts (post-sync distribution)
 *   • "N stocks changed segment" headline
 *   • Top 8 moves (Symbol · from → to)
 *   • "N rows not on NSE (untouched)" footer if applicable
 *
 * Failure surfaces the stage (fetch / load / update) so the user
 * can tell whether NSE was down, the DB was down, or a specific
 * bucket update failed.
 */
export function CapClassificationCard({ data }: Props) {
  const router = useRouter();
  const [state, setState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [result, setResult] = useState<RefreshResponse | null>(null);
  // Which bucket's drill-down modal (if any) is currently open. `null`
  // = no modal. Kept as the descriptor rather than just the key so we
  // don't need to re-derive the modal props on every render.
  const [modalBucket, setModalBucket] =
    useState<CapBucketDescriptor | null>(null);

  async function handleClick() {
    setState("loading");
    setResult(null);
    try {
      const res = await fetch("/api/refresh-cap-classifications", {
        method: "POST",
      });
      const json = (await res.json()) as RefreshResponse;
      setResult(json);
      if (!res.ok || !json.ok) {
        setState("error");
        return;
      }
      setState("success");
      // Refresh server components so the tile counts pick up the new
      // distribution — otherwise the "before" numbers stay visible
      // until the user hits F5.
      router.refresh();
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
      setState("error");
    }
  }

  // Which tile counts to show: post-sync `result.counts` + `subCounts`
  // if we just ran (India buckets only — Refresh is India-scoped),
  // otherwise the current DB distribution from server data. US always
  // uses the server value because Refresh doesn't touch it.
  const shownCounts = ((): {
    LargeN50: number;
    LargeNN50: number;
    LargeOverride: number;
    Mid: number;
    Small: number;
    Micro: number;
    Nano: number;
    US: number;
    unclassified: number;
  } => {
    if (result && result.ok) {
      // Post-refresh subCounts.Override reflects the full picture
      // (manual overrides + legacy source strings). We prefer the
      // fresh sub-tally over data.counts.LargeOverride so the tile
      // stays in sync if the user ran set-cap-override.mjs between
      // page load and clicking Refresh.
      return {
        LargeN50: result.subCounts.N50,
        LargeNN50: result.subCounts.NN50,
        LargeOverride: result.subCounts.Override,
        Mid: result.counts.Mid,
        Small: result.counts.Small,
        Micro: result.counts.Micro,
        Nano: result.counts.Nano,
        US: data.counts.US,
        unclassified: data.counts.unclassified,
      };
    }
    return {
      LargeN50: data.counts.LargeN50,
      LargeNN50: data.counts.LargeNN50,
      LargeOverride: data.counts.LargeOverride,
      Mid: data.counts.Mid,
      Small: data.counts.Small,
      Micro: data.counts.Micro,
      Nano: data.counts.Nano,
      US: data.counts.US,
      unclassified: data.counts.unclassified,
    };
  })();
  const indiaTotal =
    shownCounts.LargeN50 +
    shownCounts.LargeNN50 +
    shownCounts.LargeOverride +
    shownCounts.Mid +
    shownCounts.Small +
    shownCounts.Micro +
    shownCounts.Nano +
    shownCounts.unclassified;
  const usTotal = shownCounts.US;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Building2 size={14} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              Cap classifications
            </h2>
            <Tooltip
              content={
                <div className="max-w-xs space-y-2">
                  <p className="font-medium text-foreground">
                    Cap classification sources
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">India:</span> Nifty
                    50 → Large / N50 · Nifty Next 50 → Large / NN50 ·
                    Midcap 150 → Mid · Smallcap 250 → Small · Microcap
                    250 → Micro. Everything else on NSE (EQ series)
                    → Nano.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    All three Large sub-buckets store
                    mcap_classification=&quot;Large&quot;. N50 vs NN50
                    is decided by the source column (nse-nifty50 /
                    nse-niftynext50). Large / OVR captures Large-
                    tagged rows without a canonical NSE source —
                    manual overrides for demergers, spin-offs, and
                    freshly-listed stocks — kept separate so N50 and
                    NN50 match NSE&apos;s index definitions exactly
                    (50 stocks each). All three roll up as 100 %
                    Large in the portfolio look-through.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">US:</span> All rows
                    tagged as &quot;US&quot;. SP500 / Nasdaq 100
                    detail lives in the Index column of the drill-down
                    modal.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Refresh syncs India from NSE. US is a one-shot
                    backfill and is not touched by the button.
                  </p>
                </div>
              }
              side="bottom"
            >
              <span className="cursor-help text-[10px] text-muted-foreground/70">
                ⓘ
              </span>
            </Tooltip>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Click any tile to see its stocks · {indiaTotal} India
            equities · {usTotal} US equities
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={handleClick}
          disabled={state === "loading"}
        >
          {state === "loading" ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Refreshing…
            </>
          ) : (
            <>
              <RefreshCw size={14} /> Refresh
            </>
          )}
        </Button>
      </div>

      {/* Tile grid — always visible, doubles as the "current state" view.
         Colors span success → primary → warning → danger as a proxy
         for market-cap risk on the India tiles; US uses the intl
         purple to signal it's a different taxonomy. LargeN50 and
         LargeNN50 share a green family (N50 = brighter, NN50 =
         muted) to signal "same tier, sub-slice". Small and Micro
         share the warning hue on purpose — both mid-risk regimes
         and a common fund mixing pattern.

         Each tile is a <button> so it doubles as the drill-down
         trigger. `disabled` when count is 0 so the user doesn't
         click into an empty modal. Grid is `grid-cols-2` on mobile,
         stepping up to 4 and then 8 cols on wider screens so the 8
         tiles don't crush the number/label at any breakpoint. */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {ORDERED_KEYS.map((key) => {
          const meta = BUCKET_META[key];
          const count = shownCounts[key];
          const disabled = count === 0;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() =>
                setModalBucket({
                  key,
                  title: meta.title,
                  kicker: meta.kicker,
                  description: meta.description,
                  region: meta.region,
                })
              }
              className={
                "group rounded-md border border-border bg-muted/20 px-3 py-2 text-left transition-colors " +
                (disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-primary/40 hover:bg-muted/40")
              }
              aria-label={`Show ${count} ${meta.title} stocks`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: meta.dotColor }}
                />
                <span className="kicker">{meta.tileLabel}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-1">
                <span className="text-lg font-semibold text-foreground tabular-nums">
                  {count}
                </span>
                {!disabled && (
                  <span className="text-[9px] text-muted-foreground/60 transition-opacity group-hover:text-muted-foreground">
                    view →
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Drill-down modal — receives the pre-grouped, pre-sorted stock
         list from server data. `stocks={[]}` fallback keeps the modal
         renderable during edge cases (e.g. a bucket with zero rows
         that somehow got clicked). */}
      <CapDetailModal
        bucket={modalBucket}
        stocks={
          modalBucket ? data.stocks[modalBucket.key] ?? [] : []
        }
        onClose={() => setModalBucket(null)}
      />

      {/* Status footer — either last-synced ticker or fresh diff */}
      <div className="mt-4 border-t border-border pt-3">
        {state === "idle" && (
          <div className="flex items-center gap-2 text-xs">
            {data.lastSyncedAt ? (
              <>
                <PulseDot color="success" />
                <span className="text-muted-foreground">
                  Last synced <TimeAgo isoDate={data.lastSyncedAt} />
                </span>
              </>
            ) : (
              <>
                <PulseDot color="warning" />
                <span className="text-muted-foreground">
                  Not synced yet — click Refresh to populate from NSE
                </span>
              </>
            )}
            {shownCounts.unclassified > 0 && (
              <span className="text-muted-foreground/60">
                · {shownCounts.unclassified} unclassified
              </span>
            )}
            {data.manualOverrideCount > 0 && (
              <Tooltip
                content={
                  <div className="max-w-[240px] leading-snug">
                    Rows whose{" "}
                    <code className="font-mono text-[10px]">confidence</code>{" "}
                    contains{" "}
                    <code className="font-mono text-[10px]">manual</code>{" "}
                    are shielded from the NSE refresh — used for demerger
                    entities, spin-offs, and other stocks not yet in NSE
                    index CSVs. Add more via{" "}
                    <code className="font-mono text-[10px]">
                      scripts/set-cap-override.mjs
                    </code>
                    .
                  </div>
                }
              >
                <span className="cursor-help text-muted-foreground/60 underline decoration-dotted underline-offset-2">
                  · {data.manualOverrideCount} manual override
                  {data.manualOverrideCount === 1 ? "" : "s"}
                </span>
              </Tooltip>
            )}
          </div>
        )}

        {state === "loading" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PulseDot color="primary" />
            Fetching 4 index CSVs + EQUITY_L, then re-computing
            buckets…
          </div>
        )}

        {state === "success" && result?.ok && (
          <SuccessSummary result={result} />
        )}

        {state === "error" && result && !result.ok && (
          <div className="text-xs text-[hsl(var(--danger))]">
            <div className="flex items-center gap-2">
              <PulseDot color="danger" />
              <span className="font-medium">
                Failed{result.stage ? ` at ${result.stage}` : ""}
                {result.bucket ? ` (${result.bucket})` : ""}
              </span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {result.error ?? "Unknown error"}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function SuccessSummary({
  result,
}: {
  result: Extract<RefreshResponse, { ok: true }>;
}) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <PulseDot color="success" />
        <span className="text-foreground">
          {result.movesCount === 0 ? (
            <>Nothing changed — already in sync with NSE</>
          ) : (
            <>
              <span className="font-semibold">
                {result.movesCount}
              </span>{" "}
              {result.movesCount === 1 ? "stock" : "stocks"} moved
              between segments
            </>
          )}
        </span>
        <span className="text-muted-foreground">
          · {result.elapsedMs}ms · fetched{" "}
          {result.sourceCounts.universe} NSE listings
        </span>
      </div>

      {result.moves.length > 0 && (
        <div className="mt-2 space-y-1">
          {result.moves.slice(0, 8).map((m) => (
            <div
              key={m.isin}
              className="flex items-center gap-2 text-[11px] text-muted-foreground"
            >
              <a
                href={`https://www.nseindia.com/get-quotes/equity?symbol=${m.symbol ?? ""}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-[7ch] font-mono text-foreground hover:underline"
              >
                {m.symbol ?? m.isin}
              </a>
              <span className="text-muted-foreground">
                {formatMoveTier(m.from, m.fromSub) ?? "—"}
              </span>
              <span className="text-muted-foreground/60">→</span>
              <span className="font-medium text-foreground">
                {formatMoveTier(m.to, m.toSub)}
              </span>
            </div>
          ))}
          {result.movesCount > 8 && (
            <div className="text-[11px] text-muted-foreground/60">
              + {result.movesCount - 8} more
            </div>
          )}
        </div>
      )}

      {result.sourceNormalizedCount > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground/70">
          <span>
            + {result.sourceNormalizedCount}{" "}
            {result.sourceNormalizedCount === 1 ? "row" : "rows"}{" "}
            had their <code className="font-mono text-[10px]">source</code>{" "}
            column normalised (tier unchanged) — one-time cleanup, will
            settle to 0 on next Refresh
          </span>
        </div>
      )}

      {result.manualOverridesPreserved > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground/70">
          <span>
            {result.manualOverridesPreserved} manual override
            {result.manualOverridesPreserved === 1 ? "" : "s"} preserved
            — rows tagged with{" "}
            <code className="font-mono text-[10px]">confidence</code>{" "}
            containing <code className="font-mono text-[10px]">manual</code>{" "}
            are never touched by refresh
          </span>
        </div>
      )}

      {result.autoClearedOverridesCount > 0 && (
        <AutoClearedOverridesBlock
          overrides={result.autoClearedOverrides}
          count={result.autoClearedOverridesCount}
        />
      )}

      {result.outsideCount > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <ExternalLink size={10} />
          <span>
            {result.outsideCount}{" "}
            {result.outsideCount === 1 ? "row" : "rows"} not listed on
            NSE (BSE-only, delisted, or foreign) — left unchanged
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Combine a top-level bucket + sub-bucket into a compact display
 * string for the moves list. Examples:
 *   ("Large", "N50")  → "Large / N50"
 *   ("Large", "NN50") → "Large / NN50"
 *   ("Mid", null)     → "Mid"
 *   (null, null)      → null (caller renders "—")
 * Keeps the Large sub-split visible in the diff without cluttering
 * the non-Large rows.
 */
function formatMoveTier(
  bucket: string | null,
  sub: "N50" | "NN50" | null
): string | null {
  if (!bucket) return null;
  if (bucket === "Large" && sub) return `${bucket} / ${sub}`;
  return bucket;
}

/**
 * Auto-cleared overrides block.
 *
 * Shows in the refresh summary when NSE has officially caught up to
 * one or more manual pins during THIS sweep — i.e., the fresh
 * classifier agreed with the sticky row's declared tier + sub-bucket,
 * so the refresh dropped the manual flag in-place. `mcap` and
 * `source` were left exactly as they were (they already matched
 * the classifier), only `confidence` moved from
 * "isin-verified-manual-override" back to "isin-verified".
 *
 * Rendered in success green — this is a positive event, not a
 * warning. Lists up to 5 ISINs by symbol with their now-agreed tier,
 * then a "+ N more" spillover for larger sweeps. The copy explains
 * both what happened (auto-clear) and the downstream implication
 * (future NSE rebalances will now flow through these rows).
 */
function AutoClearedOverridesBlock({
  overrides,
  count,
}: {
  overrides: Extract<
    RefreshResponse,
    { ok: true }
  >["autoClearedOverrides"];
  count: number;
}) {
  const shown = overrides.slice(0, 5);
  return (
    <div className="mt-3 rounded-md border border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/5 p-2.5 text-[11px]">
      <div className="flex items-center gap-1.5 font-medium text-foreground/90">
        <PulseDot color="success" />
        <span>
          {count} manual override{count === 1 ? "" : "s"} auto-cleared
          — NSE has caught up
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        The fresh classifier agreed with each pin&apos;s declared tier +
        sub-bucket, so the sweep dropped their manual flag in-place.
        {" "}<code className="font-mono text-[10px]">mcap</code> and{" "}
        <code className="font-mono text-[10px]">source</code> stayed
        identical — only{" "}
        <code className="font-mono text-[10px]">confidence</code>{" "}
        moved from{" "}
        <code className="font-mono text-[10px]">
          isin-verified-manual-override
        </code>{" "}
        →{" "}
        <code className="font-mono text-[10px]">isin-verified</code>.
        Future NSE rebalances will now reclassify these rows normally.
      </div>
      <ul className="mt-2 space-y-0.5">
        {shown.map((o) => (
          <li key={o.isin} className="flex items-center gap-2">
            <span className="min-w-[7ch] font-mono text-foreground">
              {o.symbol ?? o.isin}
            </span>
            <span className="text-muted-foreground">
              now{" "}
              {formatMoveTier(o.bucket, o.subBucket) ?? o.bucket} in NSE
            </span>
          </li>
        ))}
        {count > shown.length && (
          <li className="text-muted-foreground/60">
            + {count - shown.length} more
          </li>
        )}
      </ul>
    </div>
  );
}
