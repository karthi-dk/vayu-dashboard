export type StudioTelemetryTheme =
  | "classic"
  | "claymorphic"
  | "glassmorphic"
  | "neumorphic"
  | "skeuomorphic"
  | "unknown";

/** Ordered, named studio themes (excludes the "unknown" fallback
 *  bucket) — single source of truth for anywhere theme coverage is
 *  listed in the UI (e.g. StudioRecordingConsistencyCard), so adding
 *  a new theme doesn't require hunting down hardcoded `<li>` rows. */
export const STUDIO_TELEMETRY_THEMES: Exclude<
  StudioTelemetryTheme,
  "unknown"
>[] = ["classic", "claymorphic", "glassmorphic", "neumorphic", "skeuomorphic"];

export type StudioTelemetryDeviceClass =
  | "desktop"
  | "tablet"
  | "mobile"
  | "unknown";

export type StudioTelemetryBrowserFamily =
  | "chromium"
  | "safari"
  | "firefox"
  | "edge"
  | "other"
  | "unknown";

export type StudioTelemetryPlatform =
  | "macos"
  | "windows"
  | "ios"
  | "android"
  | "linux"
  | "unknown";

export type StudioTelemetryRuntimeSurface =
  | "browser_tab"
  | "installed_app"
  | "android_twa"
  | "unknown";

export type StudioTelemetryDisplayMode =
  | "browser"
  | "standalone"
  | "minimal-ui"
  | "fullscreen"
  | "window-controls-overlay"
  | "unknown";

export type StudioTelemetryMetadata = Record<
  string,
  string | number | boolean | null
>;

export type StudioTelemetryIngestEvent = {
  clientEventId: string;
  atIso: string;
  runId: string;
  theme: StudioTelemetryTheme;
  kind: "timing" | "rollup" | "interaction";
  name?: string;
  metric?: string;
  scheduledMs?: number;
  actualMs?: number;
  driftMs?: number;
  targetDurationMs?: number;
  actualDurationMs?: number;
  delayMs?: number;
  durationDriftMs?: number;
  metadata?: StudioTelemetryMetadata;
  context: {
    pathname: string | null;
    referrer: string | null;
    userAgent: string | null;
    deviceClass: StudioTelemetryDeviceClass;
    browserFamily: StudioTelemetryBrowserFamily;
    platform: StudioTelemetryPlatform;
    runtimeSurface: StudioTelemetryRuntimeSurface;
    displayMode: StudioTelemetryDisplayMode;
    isStandalone: boolean;
  };
};

export type StudioTelemetryEvent =
  | {
      id: string;
      atIso: string;
      runId: string;
      theme: StudioTelemetryTheme;
      kind: "timing";
      name: string;
      scheduledMs: number;
      actualMs: number;
      driftMs: number;
    }
  | {
      id: string;
      atIso: string;
      runId: string;
      theme: StudioTelemetryTheme;
      kind: "rollup";
      metric: string;
      targetDurationMs: number;
      actualDurationMs: number;
      delayMs: number;
      durationDriftMs: number;
    }
  | {
      id: string;
      atIso: string;
      runId: string;
      theme: StudioTelemetryTheme;
      kind: "interaction";
      name: string;
      metadata?: Record<string, string | number | boolean | null>;
    };

export type DriftSummary = {
  count: number;
  meanAbsDriftMs: number;
  p95AbsDriftMs: number;
  worstAbsDriftMs: number;
};

export type RollupSummary = {
  count: number;
  meanDurationDriftMs: number;
  p95DurationDriftMs: number;
  worstDurationDriftMs: number;
};

export type StudioTelemetrySummary = {
  eventCount: number;
  runCount: number;
  lastEventAtIso: string | null;
  byTheme: Record<StudioTelemetryTheme, number>;
  audioTiming: Record<"swoosh" | "ding" | "rollup" | "verdict", DriftSummary>;
  rollups: RollupSummary;
};

const STORAGE_KEY = "studio.recording.telemetry.v1";
const PENDING_STORAGE_KEY = "studio.recording.telemetry.pending.v1";
const SYNC_BLOCKED_UNTIL_KEY = "studio.recording.telemetry.syncBlockedUntil.v1";
const MAX_EVENTS = 600;
const MAX_PENDING_EVENTS = 1500;
const MAX_UPLOAD_BATCH = 120;
const BASE_FLUSH_DELAY_MS = 1200;
const GENERIC_BACKOFF_MS = 20_000;
const TABLE_MISSING_BACKOFF_MS = 5 * 60 * 1000;

let flushInFlight = false;
let flushTimerId: number | null = null;
let flushBackoffUntilMs = 0;
let flushListenersBound = false;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeReadEvents(): StudioTelemetryEvent[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StudioTelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

function safeWriteEvents(events: StudioTelemetryEvent[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // localStorage may be disabled or quota-limited.
  }
}

function safeReadPendingEvents(): StudioTelemetryIngestEvent[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StudioTelemetryIngestEvent[]) : [];
  } catch {
    return [];
  }
}

function safeWritePendingEvents(events: StudioTelemetryIngestEvent[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // localStorage may be disabled or quota-limited.
  }
}

function readSyncBlockedUntilMs(): number {
  if (!hasWindow()) return 0;
  try {
    const raw = window.localStorage.getItem(SYNC_BLOCKED_UNTIL_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    if (parsed <= Date.now()) {
      window.localStorage.removeItem(SYNC_BLOCKED_UNTIL_KEY);
      return 0;
    }
    return parsed;
  } catch {
    return 0;
  }
}

function writeSyncBlockedUntilMs(untilMs: number): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(SYNC_BLOCKED_UNTIL_KEY, String(untilMs));
  } catch {
    // localStorage may be disabled or quota-limited.
  }
}

function clearSyncBlockedUntilMs(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(SYNC_BLOCKED_UNTIL_KEY);
  } catch {
    // ignore storage failures
  }
}

function detectDeviceClass(userAgent: string): StudioTelemetryDeviceClass {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (
    /(ipad|tablet|playbook|silk)/i.test(ua) ||
    (ua.includes("android") && !ua.includes("mobile"))
  ) {
    return "tablet";
  }
  if (/(mobi|iphone|ipod|android)/i.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

function detectBrowserFamily(userAgent: string): StudioTelemetryBrowserFamily {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("firefox/")) return "firefox";
  if (ua.includes("chrome/") || ua.includes("chromium/") || ua.includes("crios/")) {
    return "chromium";
  }
  if (ua.includes("safari/")) return "safari";
  return "other";
}

function detectPlatform(userAgent: string): StudioTelemetryPlatform {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return "ios";
  }
  if (ua.includes("android")) return "android";
  if (ua.includes("macintosh") || ua.includes("mac os x")) return "macos";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function isIosStandalone(): boolean {
  if (!hasWindow() || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function detectDisplayMode(): StudioTelemetryDisplayMode {
  if (!hasWindow() || typeof window.matchMedia !== "function") {
    return isIosStandalone() ? "standalone" : "unknown";
  }

  const checks: Array<StudioTelemetryDisplayMode> = [
    "window-controls-overlay",
    "standalone",
    "minimal-ui",
    "fullscreen",
    "browser",
  ];

  for (const mode of checks) {
    try {
      if (window.matchMedia(`(display-mode: ${mode})`).matches) {
        return mode;
      }
    } catch {
      // ignore matchMedia issues and continue probing
    }
  }

  return isIosStandalone() ? "standalone" : "unknown";
}

function detectRuntimeSurface(
  displayMode: StudioTelemetryDisplayMode,
  referrer: string | null
): StudioTelemetryRuntimeSurface {
  if (typeof referrer === "string" && referrer.startsWith("android-app://")) {
    return "android_twa";
  }

  if (
    displayMode === "standalone" ||
    displayMode === "minimal-ui" ||
    displayMode === "fullscreen" ||
    displayMode === "window-controls-overlay" ||
    isIosStandalone()
  ) {
    return "installed_app";
  }

  if (displayMode === "browser") return "browser_tab";
  return "unknown";
}

function currentContext(): StudioTelemetryIngestEvent["context"] {
  if (!hasWindow()) {
    return {
      pathname: null,
      referrer: null,
      userAgent: null,
      deviceClass: "unknown",
      browserFamily: "unknown",
      platform: "unknown",
      runtimeSurface: "unknown",
      displayMode: "unknown",
      isStandalone: false,
    };
  }
  const pathname =
    typeof window.location?.pathname === "string"
      ? window.location.pathname
      : null;
  const referrer =
    typeof document !== "undefined" && typeof document.referrer === "string"
      ? document.referrer
      : null;
  const userAgent =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "";
  const displayMode = detectDisplayMode();
  const runtimeSurface = detectRuntimeSurface(displayMode, referrer);
  const standalone =
    runtimeSurface === "installed_app" || runtimeSurface === "android_twa";

  return {
    pathname,
    referrer: referrer || null,
    userAgent: userAgent || null,
    deviceClass: detectDeviceClass(userAgent),
    browserFamily: detectBrowserFamily(userAgent),
    platform: detectPlatform(userAgent),
    runtimeSurface,
    displayMode,
    isStandalone: standalone,
  };
}

function toIngestEvent(event: StudioTelemetryEvent): StudioTelemetryIngestEvent {
  const base: StudioTelemetryIngestEvent = {
    clientEventId: event.id,
    atIso: event.atIso,
    runId: event.runId,
    theme: event.theme,
    kind: event.kind,
    context: currentContext(),
  };

  if (event.kind === "timing") {
    return {
      ...base,
      name: event.name,
      scheduledMs: event.scheduledMs,
      actualMs: event.actualMs,
      driftMs: event.driftMs,
    };
  }

  if (event.kind === "rollup") {
    return {
      ...base,
      metric: event.metric,
      targetDurationMs: event.targetDurationMs,
      actualDurationMs: event.actualDurationMs,
      delayMs: event.delayMs,
      durationDriftMs: event.durationDriftMs,
    };
  }

  return {
    ...base,
    name: event.name,
    metadata: event.metadata,
  };
}

function enqueuePendingEvent(event: StudioTelemetryEvent): void {
  const pending = safeReadPendingEvents();
  const next = [...pending, toIngestEvent(event)];
  if (next.length > MAX_PENDING_EVENTS) {
    safeWritePendingEvents(next.slice(next.length - MAX_PENDING_EVENTS));
    return;
  }
  safeWritePendingEvents(next);
}

function ensureFlushListenersBound(): void {
  if (!hasWindow() || flushListenersBound) return;
  flushListenersBound = true;

  window.addEventListener("online", () => {
    scheduleFlush(250);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleFlush(300);
    }
  });
}

function scheduleFlush(delayMs: number = BASE_FLUSH_DELAY_MS): void {
  if (!hasWindow()) return;
  ensureFlushListenersBound();
  if (flushTimerId != null) return;
  const blockedUntilMs = Math.max(flushBackoffUntilMs, readSyncBlockedUntilMs());
  const backoffWaitMs = Math.max(0, blockedUntilMs - Date.now());
  const waitMs = Math.max(delayMs, backoffWaitMs);
  flushTimerId = window.setTimeout(() => {
    flushTimerId = null;
    void flushStudioTelemetryToServer();
  }, waitMs);
}

export async function flushStudioTelemetryToServer(): Promise<{
  sent: number;
  pending: number;
}> {
  if (!hasWindow()) return { sent: 0, pending: 0 };
  if (flushInFlight) {
    return { sent: 0, pending: safeReadPendingEvents().length };
  }

  const blockedUntilMs = Math.max(flushBackoffUntilMs, readSyncBlockedUntilMs());
  if (Date.now() < blockedUntilMs) {
    flushBackoffUntilMs = blockedUntilMs;
    scheduleFlush(BASE_FLUSH_DELAY_MS);
    return { sent: 0, pending: safeReadPendingEvents().length };
  }

  flushInFlight = true;
  let sent = 0;

  try {
    for (let loops = 0; loops < 8; loops++) {
      const pending = safeReadPendingEvents();
      if (pending.length === 0) {
        flushBackoffUntilMs = 0;
        break;
      }

      const batch = pending.slice(0, MAX_UPLOAD_BATCH);
      const res = await fetch("/api/studio-telemetry/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        keepalive: true,
        body: JSON.stringify({ events: batch }),
      });

      if (!res.ok) {
        let code: string | null = null;
        try {
          const payload = (await res.json()) as { code?: unknown };
          code = typeof payload.code === "string" ? payload.code : null;
        } catch {
          // ignore JSON parse errors, status fallback below
        }

        if (res.status === 503 && code === "table_missing") {
          const untilMs = Date.now() + TABLE_MISSING_BACKOFF_MS;
          flushBackoffUntilMs = untilMs;
          writeSyncBlockedUntilMs(untilMs);
          scheduleFlush(TABLE_MISSING_BACKOFF_MS);
          return { sent, pending: safeReadPendingEvents().length };
        }

        throw new Error(`sync failed: ${res.status}`);
      }

      clearSyncBlockedUntilMs();
      flushBackoffUntilMs = 0;

      // On success we drop the sent batch regardless of server-side
      // duplicate suppression. The row-level unique key handles replay.
      safeWritePendingEvents(pending.slice(batch.length));
      sent += batch.length;
    }
  } catch {
    flushBackoffUntilMs = Date.now() + GENERIC_BACKOFF_MS;
    scheduleFlush(GENERIC_BACKOFF_MS);
  } finally {
    flushInFlight = false;
  }

  return { sent, pending: safeReadPendingEvents().length };
}

export function getPendingStudioTelemetryCount(): number {
  return safeReadPendingEvents().length;
}

export function clearPendingStudioTelemetryEvents(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(PENDING_STORAGE_KEY);
    window.localStorage.removeItem(SYNC_BLOCKED_UNTIL_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

function appendEvent(event: StudioTelemetryEvent): void {
  const prior = safeReadEvents();
  const next = [...prior, event];
  if (next.length > MAX_EVENTS) {
    safeWriteEvents(next.slice(next.length - MAX_EVENTS));
  } else {
    safeWriteEvents(next);
  }

  enqueuePendingEvent(event);
  scheduleFlush();
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

export function createStudioTelemetryRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveStudioTelemetryTheme(pathname: string): StudioTelemetryTheme {
  if (pathname === "/studio" || pathname === "/studio/") return "classic";
  if (pathname.startsWith("/studio/claymorphic")) return "claymorphic";
  if (pathname.startsWith("/studio/glassmorphic")) return "glassmorphic";
  if (pathname.startsWith("/studio/neumorphic")) return "neumorphic";
  if (pathname.startsWith("/studio/skeuomorphic")) return "skeuomorphic";
  return "unknown";
}

export function recordStudioTimingSample({
  runId,
  theme,
  name,
  scheduledMs,
  actualMs,
}: {
  runId: string;
  theme: StudioTelemetryTheme;
  name: "swoosh" | "ding" | "rollup" | "verdict";
  scheduledMs: number;
  actualMs: number;
}): void {
  appendEvent({
    id: randomId("timing"),
    atIso: new Date().toISOString(),
    runId,
    theme,
    kind: "timing",
    name,
    scheduledMs,
    actualMs,
    driftMs: actualMs - scheduledMs,
  });
}

export function recordStudioRollupSample({
  runId,
  theme,
  metric,
  targetDurationMs,
  actualDurationMs,
  delayMs,
}: {
  runId: string;
  theme: StudioTelemetryTheme;
  metric: string;
  targetDurationMs: number;
  actualDurationMs: number;
  delayMs: number;
}): void {
  appendEvent({
    id: randomId("rollup"),
    atIso: new Date().toISOString(),
    runId,
    theme,
    kind: "rollup",
    metric,
    targetDurationMs,
    actualDurationMs,
    delayMs,
    durationDriftMs: actualDurationMs - targetDurationMs,
  });
}

export function recordStudioInteraction({
  runId,
  theme,
  name,
  metadata,
}: {
  runId: string;
  theme: StudioTelemetryTheme;
  name: string;
  metadata?: Record<string, string | number | boolean | null>;
}): void {
  appendEvent({
    id: randomId("interaction"),
    atIso: new Date().toISOString(),
    runId,
    theme,
    kind: "interaction",
    name,
    metadata,
  });
}

export function readStudioTelemetryEvents(): StudioTelemetryEvent[] {
  return safeReadEvents();
}

export function clearStudioTelemetryEvents(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore localStorage failures
  }
}

export function summarizeStudioTelemetry(
  events: StudioTelemetryEvent[]
): StudioTelemetrySummary {
  const themeCounts: Record<StudioTelemetryTheme, number> = {
    classic: 0,
    claymorphic: 0,
    glassmorphic: 0,
    neumorphic: 0,
    skeuomorphic: 0,
    unknown: 0,
  };

  const runIds = new Set<string>();
  const audioBuckets: Record<"swoosh" | "ding" | "rollup" | "verdict", number[]> = {
    swoosh: [],
    ding: [],
    rollup: [],
    verdict: [],
  };
  const rollupDrift: number[] = [];

  let lastEventAtIso: string | null = null;

  for (const event of events) {
    runIds.add(event.runId);
    themeCounts[event.theme] = (themeCounts[event.theme] ?? 0) + 1;
    if (lastEventAtIso == null || event.atIso > lastEventAtIso) {
      lastEventAtIso = event.atIso;
    }

    if (event.kind === "timing") {
      if (event.name in audioBuckets) {
        const key = event.name as "swoosh" | "ding" | "rollup" | "verdict";
        audioBuckets[key].push(event.driftMs);
      }
    }

    if (event.kind === "rollup") {
      rollupDrift.push(event.durationDriftMs);
    }
  }

  return {
    eventCount: events.length,
    runCount: runIds.size,
    lastEventAtIso,
    byTheme: themeCounts,
    audioTiming: {
      swoosh: summarizeDrift(audioBuckets.swoosh),
      ding: summarizeDrift(audioBuckets.ding),
      rollup: summarizeDrift(audioBuckets.rollup),
      verdict: summarizeDrift(audioBuckets.verdict),
    },
    rollups: summarizeRollup(rollupDrift),
  };
}

export function readStudioTelemetrySummary(): StudioTelemetrySummary {
  return summarizeStudioTelemetry(readStudioTelemetryEvents());
}
