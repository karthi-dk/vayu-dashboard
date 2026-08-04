import "server-only";

import { sbServer } from "@/lib/supabase";
import type {
  DriftSummary,
  RollupSummary,
  StudioTelemetryBrowserFamily,
  StudioTelemetryDisplayMode,
  StudioTelemetryDeviceClass,
  StudioTelemetryIngestEvent,
  StudioTelemetryPlatform,
  StudioTelemetryRuntimeSurface,
  StudioTelemetryTheme,
} from "@/lib/studio/recordingTelemetry";

type TelemetryKind = "timing" | "rollup" | "interaction";

type TimingName = "swoosh" | "ding" | "rollup" | "verdict";

type StudioTelemetryInsertRow = {
  client_event_id: string;
  run_id: string;
  theme: StudioTelemetryTheme;
  kind: TelemetryKind;
  name: string | null;
  metric: string | null;
  scheduled_ms: number | null;
  actual_ms: number | null;
  drift_ms: number | null;
  target_duration_ms: number | null;
  actual_duration_ms: number | null;
  delay_ms: number | null;
  duration_drift_ms: number | null;
  metadata: Record<string, string | number | boolean | null>;
  pathname: string | null;
  referrer: string | null;
  user_agent: string | null;
  device_class: StudioTelemetryDeviceClass;
  browser_family: StudioTelemetryBrowserFamily;
  platform: StudioTelemetryPlatform;
  runtime_surface: StudioTelemetryRuntimeSurface;
  display_mode: StudioTelemetryDisplayMode;
  is_standalone: boolean;
  client_captured_at: string;
};

type StudioTelemetryRemoteRow = {
  client_event_id: string;
  run_id: string;
  theme: StudioTelemetryTheme;
  kind: TelemetryKind;
  name: string | null;
  drift_ms: number | null;
  duration_drift_ms: number | null;
  device_class: StudioTelemetryDeviceClass;
  browser_family: StudioTelemetryBrowserFamily;
  platform: StudioTelemetryPlatform;
  runtime_surface: StudioTelemetryRuntimeSurface;
  display_mode: StudioTelemetryDisplayMode;
  is_standalone: boolean;
  user_agent: string | null;
  created_at: string;
};

type TopUserAgent = {
  userAgent: string;
  count: number;
};

export type StudioTelemetryRemoteSummary = {
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
  topUserAgents: TopUserAgent[];
  audioTiming: Record<TimingName, DriftSummary>;
  rollups: RollupSummary;
};

const VALID_THEMES: StudioTelemetryTheme[] = [
  "classic",
  "claymorphic",
  "glassmorphic",
  "neumorphic",
  "skeuomorphic",
  "unknown",
];
const VALID_KINDS: TelemetryKind[] = ["timing", "rollup", "interaction"];
const VALID_DEVICE_CLASSES: StudioTelemetryDeviceClass[] = [
  "desktop",
  "tablet",
  "mobile",
  "unknown",
];
const VALID_BROWSERS: StudioTelemetryBrowserFamily[] = [
  "chromium",
  "safari",
  "firefox",
  "edge",
  "other",
  "unknown",
];
const VALID_PLATFORMS: StudioTelemetryPlatform[] = [
  "macos",
  "windows",
  "ios",
  "android",
  "linux",
  "unknown",
];
const VALID_RUNTIME_SURFACES: StudioTelemetryRuntimeSurface[] = [
  "browser_tab",
  "installed_app",
  "android_twa",
  "unknown",
];
const VALID_DISPLAY_MODES: StudioTelemetryDisplayMode[] = [
  "browser",
  "standalone",
  "minimal-ui",
  "fullscreen",
  "window-controls-overlay",
  "unknown",
];
const VALID_TIMING_NAMES: TimingName[] = ["swoosh", "ding", "rollup", "verdict"];

function safeString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function safeIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sanitizeMetadata(
  value: unknown
): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (typeof raw === "string") {
      out[key.slice(0, 64)] = raw.slice(0, 200);
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key.slice(0, 64)] = raw;
      continue;
    }
    if (typeof raw === "boolean") {
      out[key.slice(0, 64)] = raw;
      continue;
    }
    if (raw === null) {
      out[key.slice(0, 64)] = null;
    }
  }
  return out;
}

function sanitizeIngestEvent(
  raw: StudioTelemetryIngestEvent
): StudioTelemetryInsertRow | null {
  const clientEventId = safeString(raw.clientEventId, 80);
  const runId = safeString(raw.runId, 80);
  const capturedAt = safeIso(raw.atIso);
  if (!clientEventId || !runId || !capturedAt) return null;

  const kind = asEnum(raw.kind, VALID_KINDS, "interaction");
  const theme = asEnum(raw.theme, VALID_THEMES, "unknown");
  const context = raw.context ?? {
    pathname: null,
    referrer: null,
    userAgent: null,
    deviceClass: "unknown" as const,
    browserFamily: "unknown" as const,
    platform: "unknown" as const,
    runtimeSurface: "unknown" as const,
    displayMode: "unknown" as const,
    isStandalone: false,
  };

  return {
    client_event_id: clientEventId,
    run_id: runId,
    theme,
    kind,
    name: safeString(raw.name, 64),
    metric: safeString(raw.metric, 120),
    scheduled_ms: safeNumber(raw.scheduledMs),
    actual_ms: safeNumber(raw.actualMs),
    drift_ms: safeNumber(raw.driftMs),
    target_duration_ms: safeNumber(raw.targetDurationMs),
    actual_duration_ms: safeNumber(raw.actualDurationMs),
    delay_ms: safeNumber(raw.delayMs),
    duration_drift_ms: safeNumber(raw.durationDriftMs),
    metadata: sanitizeMetadata(raw.metadata),
    pathname: safeString(context.pathname, 160),
    referrer: safeString(context.referrer, 320),
    user_agent: safeString(context.userAgent, 320),
    device_class: asEnum(context.deviceClass, VALID_DEVICE_CLASSES, "unknown"),
    browser_family: asEnum(context.browserFamily, VALID_BROWSERS, "unknown"),
    platform: asEnum(context.platform, VALID_PLATFORMS, "unknown"),
    runtime_surface: asEnum(
      context.runtimeSurface,
      VALID_RUNTIME_SURFACES,
      "unknown"
    ),
    display_mode: asEnum(context.displayMode, VALID_DISPLAY_MODES, "unknown"),
    is_standalone: context.isStandalone === true,
    client_captured_at: capturedAt,
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function summarizeDrift(values: number[]): DriftSummary {
  const abs = values.map((n) => Math.abs(n));
  return {
    count: abs.length,
    meanAbsDriftMs: mean(abs),
    p95AbsDriftMs: quantile(abs, 0.95),
    worstAbsDriftMs: abs.length > 0 ? Math.max(...abs) : 0,
  };
}

function summarizeRollup(values: number[]): RollupSummary {
  const abs = values.map((n) => Math.abs(n));
  return {
    count: abs.length,
    meanDurationDriftMs: mean(abs),
    p95DurationDriftMs: quantile(abs, 0.95),
    worstDurationDriftMs: abs.length > 0 ? Math.max(...abs) : 0,
  };
}

export async function ingestStudioTelemetryEvents(
  events: StudioTelemetryIngestEvent[]
): Promise<{ accepted: number; dropped: number }> {
  const rows: StudioTelemetryInsertRow[] = [];
  let dropped = 0;

  for (const event of events) {
    const row = sanitizeIngestEvent(event);
    if (!row) {
      dropped += 1;
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return { accepted: 0, dropped };
  }

  const chunkSize = 250;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await sbServer
      .from("studio_recording_telemetry")
      .upsert(chunk, {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }

  return { accepted: rows.length, dropped };
}

export async function purgeStudioTelemetryEvents(input?: {
  olderThanDays?: number;
}): Promise<{ deleted: number }> {
  const olderThanDays = input?.olderThanDays;
  const cutoffIso =
    typeof olderThanDays === "number" && Number.isFinite(olderThanDays) && olderThanDays > 0
      ? new Date(Date.now() - Math.floor(olderThanDays) * 24 * 60 * 60 * 1000).toISOString()
      : null;

  let countQuery = sbServer
    .from("studio_recording_telemetry")
    .select("id", { count: "exact", head: true });
  let deleteQuery = sbServer.from("studio_recording_telemetry").delete();

  if (cutoffIso) {
    countQuery = countQuery.lt("created_at", cutoffIso);
    deleteQuery = deleteQuery.lt("created_at", cutoffIso);
  } else {
    countQuery = countQuery.not("id", "is", null);
    deleteQuery = deleteQuery.not("id", "is", null);
  }

  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  const { error: deleteError } = await deleteQuery;
  if (deleteError) throw deleteError;

  return { deleted: count ?? 0 };
}

async function fetchRowsSince(sinceIso: string): Promise<StudioTelemetryRemoteRow[]> {
  const rows: StudioTelemetryRemoteRow[] = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await sbServer
      .from("studio_recording_telemetry")
      .select(
        "client_event_id,run_id,theme,kind,name,drift_ms,duration_drift_ms,device_class,browser_family,platform,runtime_surface,display_mode,is_standalone,user_agent,created_at"
      )
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    const chunk = (data ?? []) as StudioTelemetryRemoteRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }

  return rows;
}

export async function getStudioTelemetryRemoteSummary(
  windowDays = 30
): Promise<StudioTelemetryRemoteSummary> {
  const boundedDays = Math.max(1, Math.min(90, Math.floor(windowDays)));
  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await fetchRowsSince(since);

  const byTheme: Record<StudioTelemetryTheme, number> = {
    classic: 0,
    claymorphic: 0,
    glassmorphic: 0,
    neumorphic: 0,
    skeuomorphic: 0,
    unknown: 0,
  };
  const byDeviceClass: Record<StudioTelemetryDeviceClass, number> = {
    desktop: 0,
    tablet: 0,
    mobile: 0,
    unknown: 0,
  };
  const byBrowserFamily: Record<StudioTelemetryBrowserFamily, number> = {
    chromium: 0,
    safari: 0,
    firefox: 0,
    edge: 0,
    other: 0,
    unknown: 0,
  };
  const byPlatform: Record<StudioTelemetryPlatform, number> = {
    macos: 0,
    windows: 0,
    ios: 0,
    android: 0,
    linux: 0,
    unknown: 0,
  };
  const byRuntimeSurface: Record<StudioTelemetryRuntimeSurface, number> = {
    browser_tab: 0,
    installed_app: 0,
    android_twa: 0,
    unknown: 0,
  };
  const byDisplayMode: Record<StudioTelemetryDisplayMode, number> = {
    browser: 0,
    standalone: 0,
    "minimal-ui": 0,
    fullscreen: 0,
    "window-controls-overlay": 0,
    unknown: 0,
  };

  const runIds = new Set<string>();
  const userAgentCounts = new Map<string, number>();
  const timingBuckets: Record<TimingName, number[]> = {
    swoosh: [],
    ding: [],
    rollup: [],
    verdict: [],
  };
  const rollupDrift: number[] = [];
  let lastEventAtIso: string | null = null;

  for (const row of rows) {
    runIds.add(row.run_id);
    byTheme[row.theme] = (byTheme[row.theme] ?? 0) + 1;
    byDeviceClass[row.device_class] = (byDeviceClass[row.device_class] ?? 0) + 1;
    byBrowserFamily[row.browser_family] = (byBrowserFamily[row.browser_family] ?? 0) + 1;
    byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + 1;
    byRuntimeSurface[row.runtime_surface] =
      (byRuntimeSurface[row.runtime_surface] ?? 0) + 1;
    byDisplayMode[row.display_mode] = (byDisplayMode[row.display_mode] ?? 0) + 1;

    if (row.user_agent) {
      const key = row.user_agent.slice(0, 200);
      userAgentCounts.set(key, (userAgentCounts.get(key) ?? 0) + 1);
    }

    if (lastEventAtIso == null || row.created_at > lastEventAtIso) {
      lastEventAtIso = row.created_at;
    }

    if (
      row.kind === "timing" &&
      row.name &&
      (VALID_TIMING_NAMES as string[]).includes(row.name) &&
      typeof row.drift_ms === "number" &&
      Number.isFinite(row.drift_ms)
    ) {
      timingBuckets[row.name as TimingName].push(row.drift_ms);
    }

    if (
      row.kind === "rollup" &&
      typeof row.duration_drift_ms === "number" &&
      Number.isFinite(row.duration_drift_ms)
    ) {
      rollupDrift.push(row.duration_drift_ms);
    }
  }

  const topUserAgents = Array.from(userAgentCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([userAgent, count]) => ({ userAgent, count }));

  return {
    windowDays: boundedDays,
    eventCount: rows.length,
    runCount: runIds.size,
    lastEventAtIso,
    byTheme,
    byDeviceClass,
    byBrowserFamily,
    byPlatform,
    byRuntimeSurface,
    byDisplayMode,
    standaloneCount: byRuntimeSurface.installed_app + byRuntimeSurface.android_twa,
    browserTabCount: byRuntimeSurface.browser_tab,
    topUserAgents,
    audioTiming: {
      swoosh: summarizeDrift(timingBuckets.swoosh),
      ding: summarizeDrift(timingBuckets.ding),
      rollup: summarizeDrift(timingBuckets.rollup),
      verdict: summarizeDrift(timingBuckets.verdict),
    },
    rollups: summarizeRollup(rollupDrift),
  };
}
