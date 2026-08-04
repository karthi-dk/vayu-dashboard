"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { HealthCheck, SystemHealthReport } from "@/lib/systemHealthTypes";

const AUTO_REFRESH_ENABLED_KEY = "ops.health.autoRefresh.enabled";
const AUTO_REFRESH_SECONDS_KEY = "ops.health.autoRefresh.seconds";

function chip(ok: boolean): string {
  return ok
    ? "border border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-200"
    : "border border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-200";
}

function fmtTs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function fmtTsServerSafe(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return `${Math.round(ms)}ms`;
}

function tableLine(item: HealthCheck, hydrated: boolean): string {
  const status = item.ok ? "ok" : item.detail;
  const ts = hydrated ? fmtTs(item.checkedAt) : fmtTsServerSafe(item.checkedAt);
  return `${status} · ${fmtLatency(item.latencyMs)} · ${ts}`;
}

type Props = {
  initialReport: SystemHealthReport;
};

export function SystemHealthPanel({ initialReport }: Props) {
  const [report, setReport] = useState<SystemHealthReport>(initialReport);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<30 | 60>(30);
  const [hydrated, setHydrated] = useState(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    try {
      const storedEnabled = window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY);
      if (storedEnabled === "true") setAutoRefreshEnabled(true);

      const storedSeconds = window.localStorage.getItem(AUTO_REFRESH_SECONDS_KEY);
      if (storedSeconds === "60") {
        setAutoRefreshSeconds(60);
      } else if (storedSeconds === "30") {
        setAutoRefreshSeconds(30);
      }
    } catch {
      // localStorage may be unavailable (privacy mode / policy restrictions).
    }
  }, []);

  const refreshHealth = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/health/system", {
        method: "GET",
        cache: "no-store",
        headers: {
          pragma: "no-cache",
        },
      });

      const payload = (await res.json()) as Partial<SystemHealthReport>;
      if (!payload || typeof payload !== "object" || !payload.generatedAt) {
        throw new Error("Health endpoint returned an invalid payload shape");
      }
      setReport(payload as SystemHealthReport);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Failed to refresh system health");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) return;

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshHealth();
    }, autoRefreshSeconds * 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [autoRefreshEnabled, autoRefreshSeconds, refreshHealth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_REFRESH_ENABLED_KEY,
        autoRefreshEnabled ? "true" : "false"
      );
      window.localStorage.setItem(
        AUTO_REFRESH_SECONDS_KEY,
        String(autoRefreshSeconds)
      );
    } catch {
      // localStorage may be unavailable (privacy mode / policy restrictions).
    }
  }, [autoRefreshEnabled, autoRefreshSeconds]);

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">System Health</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${chip(report.overallOk)}`}
          >
            {report.overallOk ? "Healthy" : "Degraded"}
          </span>

          <label className="flex items-center gap-2 rounded-md border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(event) => {
                setAutoRefreshEnabled(event.target.checked);
              }}
              className="h-3.5 w-3.5 rounded border-zinc-400 bg-white text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-emerald-400"
            />
            Auto refresh
          </label>

          <label className="flex items-center gap-2 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            Every
            <select
              value={autoRefreshSeconds}
              onChange={(event) => {
                const next = Number(event.target.value);
                setAutoRefreshSeconds(next === 60 ? 60 : 30);
              }}
              disabled={!autoRefreshEnabled}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
            >
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              void refreshHealth();
            }}
            disabled={refreshing}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? "Refreshing..." : "Refresh health"}
          </button>
        </div>
      </div>

      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        Last report: {hydrated ? fmtTs(report.generatedAt) : fmtTsServerSafe(report.generatedAt)}
      </p>
      {refreshError ? <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{refreshError}</p> : null}

      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Environment checks
          </h3>
          <ul className="space-y-2 text-sm text-zinc-800 dark:text-zinc-300">
            <li>
              NEXT_PUBLIC_SUPABASE_URL: {report.environment.nextPublicSupabaseUrl ? "present" : "missing"}
            </li>
            <li>APP_SESSION_SECRET: {report.environment.appSessionSecret ? "present" : "missing"}</li>
            <li>
              SUPABASE_SERVICE_KEY: {report.environment.supabaseServiceKey.present ? "present" : "missing"}
              {report.environment.supabaseServiceKey.present
                ? ` (${report.environment.supabaseServiceKey.keyType}, role=${report.environment.supabaseServiceKey.inferredRole ?? "n/a"})`
                : ""}
            </li>
            <li>
              MP3 override probing: {report.environment.studioMp3OverridesEnabled ? "enabled" : "disabled"}
            </li>
            <li>
              Debug diagnostics gate: {report.diagnosticsEnabled ? "enabled" : "disabled"}
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Core table probes</h3>
          <ul className="space-y-2 text-sm text-zinc-800 dark:text-zinc-300">
            {report.tables.map((item) => (
              <li key={item.name} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 inline-block h-2.5 w-2.5 rounded-full ${
                    item.ok ? "bg-emerald-500 dark:bg-emerald-400" : "bg-rose-500 dark:bg-rose-400"
                  }`}
                />
                <span>
                  {item.name}: {tableLine(item, hydrated)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
