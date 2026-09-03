import { getFilingsData } from "@/lib/filings";
import { withTransientRetry } from "@/lib/transientRetry";
import { FilingsHeadline } from "@/components/filings/FilingsHeadline";
import { FilingsTable } from "@/components/filings/FilingsTable";
import { TaxRateChart } from "@/components/filings/TaxRateChart";
import { TaxCompositionChart } from "@/components/filings/TaxCompositionChart";

export const dynamic = "force-dynamic";

/**
 * /filings — Income Tax Return history. Ingested from the CBDT
 * e-filing portal's exported JSONs via scripts/ingest-itr-json.ts
 * (once-a-year event).
 *
 * Page anatomy
 * ────────────
 *   1. Headline strip     — "You kept ₹X of every ₹100 earned" hero
 *                            + 4-stat multi-year context
 *   2. Tax rate chart     — the primary "% of ₹100" visualization
 *   3. Tax composition    — TDS / Advance / SAT / TCS stacked
 *   4. Cross-year table   — the full facts sheet for drilldown
 *
 * Empty-state pattern
 * ───────────────────
 * If the table doesn't exist yet (migration not applied), we show
 * a short guide with the exact commands to bootstrap. Once the CLI
 * has ingested even one row, the page switches to the analytical
 * mode. This matches the graceful-degradation pattern used by
 * getOverviewData for nps_transactions / retirement_credits.
 */
export default async function FilingsPage() {
  const { returns, cumulative, tableStale } = await withTransientRetry(() =>
    getFilingsData()
  );

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="kicker mb-3">Income tax</div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Filings
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Multi-year ITR history — every filed return, its regime, tax
          rate as a fraction of ₹100 earned, and how the tax was funded
          (TDS vs Advance Tax vs Self-Assessment). Ingested from CBDT
          e-filing JSONs via the CLI. No PII (PAN, Aadhaar, address,
          bank account) is stored — only financial facts.
        </p>
      </div>

      {tableStale || returns.length === 0 ? (
        <EmptyState stale={tableStale} />
      ) : (
        <>
          <FilingsHeadline returns={returns} cumulative={cumulative} />
          <TaxRateChart returns={returns} />
          <TaxCompositionChart returns={returns} />
          <FilingsTable returns={returns} />
        </>
      )}
    </div>
  );
}

/**
 * Rendered on first visit before the migration + CLI have run. Shows
 * the exact one-time bootstrap commands so the user doesn't need to
 * find them in the README. Once at least one row is ingested this
 * disappears and the page switches to its analytical mode.
 */
function EmptyState({ stale }: { stale: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-8 text-sm">
      <h2 className="text-base font-semibold text-foreground">
        {stale ? "itr_returns table not found" : "No filings ingested yet"}
      </h2>
      <p className="mt-2 text-muted-foreground">
        {stale
          ? "Apply the migration to create the table, then ingest your ITR JSONs:"
          : "Ingest your CBDT-exported ITR JSONs to populate this page:"}
      </p>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-muted-foreground">
        {stale && (
          <li>
            Run <code className="font-mono text-foreground">migrations/2026-07-23-itr-returns.sql</code>{" "}
            in the Supabase SQL editor.
          </li>
        )}
        <li>
          From the repo root, run the ingest against your ITR-JSON folder:
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
{`npx tsx scripts/ingest-itr-json.ts \\
  "/Users/kponnu/Documents/itr-fy2025-26/All ITR JSON"`}
          </pre>
        </li>
        <li>
          Reload this page — you should see the multi-year headline,
          charts, and compliance notes.
        </li>
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        The script is idempotent — safe to re-run after adding next
        year&apos;s ITR JSON to the folder. It reads ITR-1 forms; extend
        the parser in <code className="font-mono">scripts/ingest-itr-json.ts</code>{" "}
        when you need ITR-2 support.
      </p>
    </div>
  );
}
