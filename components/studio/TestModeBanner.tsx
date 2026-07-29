"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Yellow banner at the top of /studio when NEXT_PUBLIC_FUNDS_TEST_MODE
 * is 'true'. Renders nothing when the flag is off (production mode) so
 * a real user in the deployed app never sees it.
 *
 * The env var is read once at module load via process.env — Next.js
 * inlines NEXT_PUBLIC_* values at build time, so this is effectively
 * a compile-time constant in the client bundle. Changing the flag
 * requires a rebuild + redeploy (which is what you want for a
 * test-vs-real switch — no live toggling of write semantics).
 *
 * Visible purpose: leaves zero ambiguity about whether the flow you
 * just recorded was a real trade or a rehearsal. Yellow because
 * "attention needed, but not an error" — same tone Vercel /
 * GitHub use for warnings.
 */

const IS_TEST_MODE = process.env.NEXT_PUBLIC_FUNDS_TEST_MODE === "true";

export function TestModeBanner() {
  if (!IS_TEST_MODE) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 border-b border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.12)] px-4 py-2 text-xs text-[hsl(var(--warning))]"
    >
      <AlertTriangle size={14} aria-hidden />
      <span className="font-medium tracking-wide">TEST MODE</span>
      <span className="opacity-75">
        · submissions get{" "}
        <code className="rounded bg-[hsl(var(--warning)/0.15)] px-1 py-0.5 font-mono text-[10px]">
          platform=test
        </code>{" "}
        and won&apos;t affect headline math
      </span>
    </div>
  );
}
