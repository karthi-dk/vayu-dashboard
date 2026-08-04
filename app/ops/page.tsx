import Link from "next/link";

import { SystemHealthPanel } from "@/components/ops/SystemHealthPanel";
import { StudioRecordingConsistencyCard } from "@/components/ops/StudioRecordingConsistencyCard";
import { getSystemHealthReport } from "@/lib/systemHealth";
import { withTransientRetry } from "@/lib/transientRetry";

export default async function OpsPage() {
  const report = await withTransientRetry(() => getSystemHealthReport());
  const diagnosticsOn = report.diagnosticsEnabled;

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-zinc-50 via-white to-zinc-100/80 px-4 py-8 text-zinc-900 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-900 dark:text-zinc-100 md:px-8 md:py-10">
      <div className="mx-auto max-w-6xl space-y-8 md:space-y-10">
        <header className="relative overflow-hidden rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none md:p-8">
          <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-cyan-200/50 blur-3xl dark:bg-cyan-500/20" />
          <div className="pointer-events-none absolute -bottom-16 left-8 h-40 w-40 rounded-full bg-emerald-200/45 blur-3xl dark:bg-emerald-500/20" />
          <div className="relative space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">
              Ops Control Plane
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 md:text-4xl">
            Operations And Reliability
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-zinc-700 dark:text-zinc-300 md:text-base">
              This page captures the four production hardening improvements: gated diagnostics,
              live health signals, lower startup audio noise, and CI verification for production-like PWA behavior.
            </p>
          </div>
        </header>

        <SystemHealthPanel initialReport={report} />
        <StudioRecordingConsistencyCard />

        <section className="grid gap-4 md:grid-cols-2">
          <article className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none">
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">1. Debug Route Gate</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              Sensitive diagnostics routes are now protected by an explicit production env flag.
              Local/dev stays easy, production stays private by default.
            </p>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Endpoint: /api/debug/supabase-key (404 when disabled) · gate is currently {diagnosticsOn ? "enabled" : "disabled"}
            </p>
          </article>

          <article className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none">
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">2. Health Endpoint</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              Added a compact system health API with environment and table probes.
              Response status is 200 when healthy, 503 when degraded.
            </p>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Endpoint: /api/health/system (no-store)
            </p>
          </article>

          <article className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none">
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">3. Startup Audio Noise Reduction</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              MP3 override probing can now be disabled by default and enabled only when needed,
              reducing startup fetch noise from optional sound assets.
            </p>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Control: NEXT_PUBLIC_STUDIO_MP3_OVERRIDES=true
            </p>
          </article>

          <article className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none">
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">4. CI Guardrail</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              Added a GitHub Actions workflow that builds and runs the local PWA verification script
              on every PR and push to main.
            </p>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Workflow: .github/workflows/verify-pwa-local.yml</p>
          </article>
        </section>

        <div className="rounded-2xl border border-zinc-200 bg-white/95 p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-none">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">Quick Commands</h3>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <code className="rounded border border-zinc-200 bg-zinc-100 px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">npm run build</code>
            <code className="rounded border border-zinc-200 bg-zinc-100 px-2 py-1 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">npm run verify:pwa-local</code>
          </div>
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Need full deploy steps? See <Link href="/settings" className="font-medium text-cyan-700 underline underline-offset-2 dark:text-cyan-300">Settings</Link> and DEPLOY.md.
          </p>
        </div>
      </div>
    </main>
  );
}
