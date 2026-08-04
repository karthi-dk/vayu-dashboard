"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearPendingStudioTelemetryEvents,
  clearStudioTelemetryEvents,
  flushStudioTelemetryToServer,
  readStudioTelemetrySummary,
  STUDIO_TELEMETRY_THEMES,
  type DriftSummary,
  type StudioTelemetryBrowserFamily,
  type StudioTelemetryDisplayMode,
  type StudioTelemetryDeviceClass,
  type StudioTelemetryPlatform,
  type StudioTelemetryRuntimeSurface,
  type StudioTelemetrySummary,
  type StudioTelemetryTheme,
} from "@/lib/studio/recordingTelemetry";

type ConsistencyStatus = {
  label: "Excellent" | "Good" | "Needs Attention";
  className: string;
  note: string;
};

type RemoteSummary = {
  windowDays: number;
  eventCount: number;
  runCount: number;
  lastEventAtIso: string | null;
  byTheme: Record<StudioTelemetryTheme, number>;
  byDeviceClass: Record<StudioTelemetryDeviceClass, number>;
  byBrowserFamily: Record<StudioTelemetryBrowserFamily, number>;
  byPlatform: Record<StudioTelemetryPlatform, number>;
  byRuntimeSurface: Record<StudioTelemetryRuntimeSurface, number>;
  byDisplayMode: Record<StudioTelemetryDisplayMode, number>;
  standaloneCount: number;
  browserTabCount: number;
  topUserAgents: Array<{ userAgent: string; count: number }>;
};

function fmtMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  return `${Math.round(value)}ms`;
}

function fmtLastSeen(value: string | null): string {
  if (!value) return "No data yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortenUserAgent(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

function driftTone(p95AbsDriftMs: number): string {
  if (p95AbsDriftMs <= 80) return "text-emerald-700 dark:text-emerald-300";
  if (p95AbsDriftMs <= 180) return "text-amber-700 dark:text-amber-300";
  return "text-rose-700 dark:text-rose-300";
}

function driftSummaryLine(summary: DriftSummary): string {
  if (summary.count === 0) return "no samples";
  return [
    `n=${summary.count}`,
    `mean ${fmtMs(summary.meanAbsDriftMs)}`,
    `p95 ${fmtMs(summary.p95AbsDriftMs)}`,
    `worst ${fmtMs(summary.worstAbsDriftMs)}`,
  ].join(" · ");
}

function resolveConsistencyStatus(
  summary: StudioTelemetrySummary
): ConsistencyStatus {
  const timingSeries = [
    summary.audioTiming.swoosh,
    summary.audioTiming.ding,
    summary.audioTiming.rollup,
    summary.audioTiming.verdict,
  ];

  const totalSamples =
    timingSeries.reduce((sum, item) => sum + item.count, 0) +
    summary.rollups.count;

  const p95Series = timingSeries
    .filter((item) => item.count > 0)
    .map((item) => item.p95AbsDriftMs);
  if (summary.rollups.count > 0) {
    p95Series.push(summary.rollups.p95DurationDriftMs);
  }

  if (p95Series.length === 0) {
    return {
      label: "Good",
      className:
        "border border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-200",
      note: "No timing samples yet. Run a few Studio reveals to calibrate.",
    };
  }

  const worstP95 = Math.max(...p95Series);
  if (worstP95 <= 40) {
    return {
      label: "Excellent",
      className:
        "border border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-200",
      note: `Stable timing profile. Worst p95 drift is ${fmtMs(worstP95)} across ${totalSamples} samples.`,
    };
  }

  if (worstP95 <= 120) {
    return {
      label: "Good",
      className:
        "border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-200",
      note: `Usable timing with minor jitter. Worst p95 drift is ${fmtMs(worstP95)} across ${totalSamples} samples.`,
    };
  }

  return {
    label: "Needs Attention",
    className:
      "border border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/35 dark:bg-rose-500/15 dark:text-rose-200",
    note: `Noticeable timing variance. Worst p95 drift is ${fmtMs(worstP95)} across ${totalSamples} samples.`,
  };
}

const EMPTY_SUMMARY: StudioTelemetrySummary = {
  eventCount: 0,
  runCount: 0,
  lastEventAtIso: null,
  byTheme: {
    classic: 0,
    claymorphic: 0,
    glassmorphic: 0,
    neumorphic: 0,
    skeuomorphic: 0,
    unknown: 0,
  },
  audioTiming: {
    swoosh: { count: 0, meanAbsDriftMs: 0, p95AbsDriftMs: 0, worstAbsDriftMs: 0 },
    ding: { count: 0, meanAbsDriftMs: 0, p95AbsDriftMs: 0, worstAbsDriftMs: 0 },
    rollup: { count: 0, meanAbsDriftMs: 0, p95AbsDriftMs: 0, worstAbsDriftMs: 0 },
    verdict: { count: 0, meanAbsDriftMs: 0, p95AbsDriftMs: 0, worstAbsDriftMs: 0 },
  },
  rollups: {
    count: 0,
    meanDurationDriftMs: 0,
    p95DurationDriftMs: 0,
    worstDurationDriftMs: 0,
  },
};

const EMPTY_REMOTE_SUMMARY: RemoteSummary = {
  windowDays: 30,
  eventCount: 0,
  runCount: 0,
  lastEventAtIso: null,
  byTheme: {
    classic: 0,
    claymorphic: 0,
    glassmorphic: 0,
    neumorphic: 0,
    skeuomorphic: 0,
    unknown: 0,
  },
  byDeviceClass: {
    desktop: 0,
    tablet: 0,
    mobile: 0,
    unknown: 0,
  },
  byBrowserFamily: {
    chromium: 0,
    safari: 0,
    firefox: 0,
    edge: 0,
    other: 0,
    unknown: 0,
  },
  byPlatform: {
    macos: 0,
    windows: 0,
    ios: 0,
    android: 0,
    linux: 0,
    unknown: 0,
  },
  byRuntimeSurface: {
    browser_tab: 0,
    installed_app: 0,
    android_twa: 0,
    unknown: 0,
  },
  byDisplayMode: {
    browser: 0,
    standalone: 0,
    "minimal-ui": 0,
    fullscreen: 0,
    "window-controls-overlay": 0,
    unknown: 0,
  },
  standaloneCount: 0,
  browserTabCount: 0,
  topUserAgents: [],
};

export function StudioRecordingConsistencyCard() {
  const [summary, setSummary] = useState<StudioTelemetrySummary>(EMPTY_SUMMARY);
  const [remoteSummary, setRemoteSummary] =
    useState<RemoteSummary>(EMPTY_REMOTE_SUMMARY);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteDeleting, setRemoteDeleting] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteWindowDays, setRemoteWindowDays] = useState<7 | 30 | 60>(30);

  const refreshLocal = useCallback(() => {
    setSummary(readStudioTelemetrySummary());
  }, []);

  const refreshRemote = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteError(null);

    try {
      // Try pushing pending local events before reading shared summary.
      await flushStudioTelemetryToServer();
      const res = await fetch(
        `/api/studio-telemetry/summary?days=${remoteWindowDays}`,
        {
          method: "GET",
          cache: "no-store",
          headers: {
            pragma: "no-cache",
          },
        }
      );
      const payload = (await res.json()) as Partial<RemoteSummary> & {
        error?: string;
      };

      if (!res.ok) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.eventCount !== "number" ||
        typeof payload.runCount !== "number"
      ) {
        throw new Error("Invalid shared telemetry payload");
      }

      setRemoteSummary(payload as RemoteSummary);
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoteLoading(false);
    }
  }, [remoteWindowDays]);

  const refreshAll = useCallback(() => {
    refreshLocal();
    void refreshRemote();
  }, [refreshLocal, refreshRemote]);

  const deleteSharedTelemetry = useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Delete all shared telemetry rows from DB? This cannot be undone."
      )
    ) {
      return;
    }

    setRemoteDeleting(true);
    setRemoteError(null);

    try {
      const res = await fetch("/api/studio-telemetry/events?mode=all", {
        method: "DELETE",
        cache: "no-store",
        headers: {
          pragma: "no-cache",
        },
      });
      const payload = (await res.json()) as { error?: string };

      if (!res.ok) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }

      // Prevent immediate re-upload of stale unsent batches after purge.
      clearPendingStudioTelemetryEvents();
      await refreshRemote();
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoteDeleting(false);
    }
  }, [refreshRemote]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const consistency = useMemo(
    () => resolveConsistencyStatus(summary),
    [summary]
  );

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Studio Recording Consistency</h2>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Local timing telemetry from reveal audio + roll-up animation runs, with shared pilot sync to DB.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${consistency.className}`}
            >
              {consistency.label}
            </span>
            <span className="text-xs text-zinc-700 dark:text-zinc-300">{consistency.note}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshAll}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
          >
            Refresh telemetry
          </button>
          <button
            type="button"
            onClick={() => {
              clearStudioTelemetryEvents();
              refreshLocal();
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 transition hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-rose-400/60 dark:hover:bg-rose-500/10 dark:hover:text-rose-200"
          >
            Clear local telemetry
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Events</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{summary.eventCount}</p>
        </article>
        <article className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Reveal runs</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{summary.runCount}</p>
        </article>
        <article className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Last sample</p>
          <p className="mt-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">{fmtLastSeen(summary.lastEventAtIso)}</p>
        </article>
      </div>

      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Audio timing drift</h3>
          <ul className="space-y-2 text-sm text-zinc-800 dark:text-zinc-300">
            <li className={driftTone(summary.audioTiming.swoosh.p95AbsDriftMs)}>
              swoosh: {driftSummaryLine(summary.audioTiming.swoosh)}
            </li>
            <li className={driftTone(summary.audioTiming.ding.p95AbsDriftMs)}>
              ding: {driftSummaryLine(summary.audioTiming.ding)}
            </li>
            <li className={driftTone(summary.audioTiming.rollup.p95AbsDriftMs)}>
              rollup: {driftSummaryLine(summary.audioTiming.rollup)}
            </li>
            <li className={driftTone(summary.audioTiming.verdict.p95AbsDriftMs)}>
              verdict: {driftSummaryLine(summary.audioTiming.verdict)}
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Roll-up duration drift</h3>
          <ul className="space-y-2 text-sm text-zinc-800 dark:text-zinc-300">
            <li>
              samples: <span className="tabular-nums">{summary.rollups.count}</span>
            </li>
            <li>
              mean: <span className="tabular-nums">{fmtMs(summary.rollups.meanDurationDriftMs)}</span>
            </li>
            <li>
              p95: <span className="tabular-nums">{fmtMs(summary.rollups.p95DurationDriftMs)}</span>
            </li>
            <li>
              worst: <span className="tabular-nums">{fmtMs(summary.rollups.worstDurationDriftMs)}</span>
            </li>
          </ul>
          <h3 className="pt-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Theme coverage</h3>
          <ul className="space-y-1 text-sm text-zinc-800 dark:text-zinc-300">
            {STUDIO_TELEMETRY_THEMES.map((theme) => (
              <li key={theme}>
                {theme}: <span className="tabular-nums">{summary.byTheme[theme]}</span>
              </li>
            ))}
            <li>unknown: <span className="tabular-nums">{summary.byTheme.unknown}</span></li>
          </ul>
        </div>
      </div>

      <div className="mt-6 space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/35">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
            Shared Pilot Snapshot (DB)
          </h3>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Window
              <select
                value={remoteWindowDays}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (next === 7 || next === 60) {
                    setRemoteWindowDays(next);
                  } else {
                    setRemoteWindowDays(30);
                  }
                }}
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                <option value={7}>7d</option>
                <option value={30}>30d</option>
                <option value={60}>60d</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                void refreshRemote();
              }}
              disabled={remoteLoading || remoteDeleting}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-800 transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 disabled:opacity-60"
            >
              {remoteLoading ? "Refreshing..." : "Refresh shared"}
            </button>
            <button
              type="button"
              onClick={() => {
                void deleteSharedTelemetry();
              }}
              disabled={remoteLoading || remoteDeleting}
              className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 transition hover:border-rose-400 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-transparent dark:text-rose-200 dark:hover:border-rose-400 disabled:opacity-60"
            >
              {remoteDeleting ? "Deleting..." : "Delete shared DB data"}
            </button>
          </div>
        </div>

        {remoteError ? (
          <p className="text-xs text-rose-700 dark:text-rose-300">{remoteError}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <article className="rounded-md border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950/45">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Events</p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {remoteSummary.eventCount}
                </p>
              </article>
              <article className="rounded-md border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950/45">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Reveal runs</p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {remoteSummary.runCount}
                </p>
              </article>
              <article className="rounded-md border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950/45">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500">Last sample</p>
                <p className="mt-0.5 text-xs font-medium text-zinc-800 dark:text-zinc-200">
                  {fmtLastSeen(remoteSummary.lastEventAtIso)}
                </p>
              </article>
            </div>

            <div className="grid gap-5 text-sm text-zinc-800 dark:text-zinc-300 md:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Theme coverage</p>
                <ul className="mt-1 space-y-1">
                  {STUDIO_TELEMETRY_THEMES.map((theme) => (
                    <li key={theme}>
                      {theme}: <span className="tabular-nums">{remoteSummary.byTheme[theme]}</span>
                    </li>
                  ))}
                  <li>unknown: <span className="tabular-nums">{remoteSummary.byTheme.unknown}</span></li>
                </ul>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Runtime / platform coverage</p>
                <ul className="mt-1 space-y-1">
                  <li>browser tab: <span className="tabular-nums">{remoteSummary.byRuntimeSurface.browser_tab}</span></li>
                  <li>installed app: <span className="tabular-nums">{remoteSummary.standaloneCount}</span></li>
                  <li>android TWA: <span className="tabular-nums">{remoteSummary.byRuntimeSurface.android_twa}</span></li>
                  <li>display-mode browser: <span className="tabular-nums">{remoteSummary.byDisplayMode.browser}</span></li>
                  <li>display-mode standalone: <span className="tabular-nums">{remoteSummary.byDisplayMode.standalone}</span></li>
                  <li>desktop: <span className="tabular-nums">{remoteSummary.byDeviceClass.desktop}</span></li>
                  <li>tablet: <span className="tabular-nums">{remoteSummary.byDeviceClass.tablet}</span></li>
                  <li>mobile: <span className="tabular-nums">{remoteSummary.byDeviceClass.mobile}</span></li>
                  <li>android: <span className="tabular-nums">{remoteSummary.byPlatform.android}</span></li>
                  <li>ios: <span className="tabular-nums">{remoteSummary.byPlatform.ios}</span></li>
                  <li>macos: <span className="tabular-nums">{remoteSummary.byPlatform.macos}</span></li>
                  <li>windows: <span className="tabular-nums">{remoteSummary.byPlatform.windows}</span></li>
                  <li>chromium: <span className="tabular-nums">{remoteSummary.byBrowserFamily.chromium}</span></li>
                  <li>safari: <span className="tabular-nums">{remoteSummary.byBrowserFamily.safari}</span></li>
                  <li>firefox: <span className="tabular-nums">{remoteSummary.byBrowserFamily.firefox}</span></li>
                  <li>edge: <span className="tabular-nums">{remoteSummary.byBrowserFamily.edge}</span></li>
                </ul>
              </div>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Top user agents</p>
              {remoteSummary.topUserAgents.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-500">No shared user-agent samples yet.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-xs text-zinc-800 dark:text-zinc-300">
                  {remoteSummary.topUserAgents.map((item) => (
                    <li key={item.userAgent} className="flex items-start justify-between gap-2">
                      <span className="truncate">{shortenUserAgent(item.userAgent)}</span>
                      <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{item.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
