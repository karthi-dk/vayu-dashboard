import { Card } from "@/components/ui/Card";
import { fmtL, fmtINR } from "@/lib/utils";
import type { FilingsCumulative, ItrReturn } from "@/lib/filings-types";
import { effectiveRatePct } from "@/lib/filings-types";

/**
 * Filings page headline — a two-tier strip that puts the user's "how
 * much of every ₹100 earned went to tax" question front-and-center.
 *
 * Layout
 * ──────
 * Row 1 (hero): giant per-rupee tax rate for the LATEST year, framed
 *   as "you kept ₹X of every ₹100 earned". This is the single number
 *   the user asked to see; nothing else on the page competes with it.
 *
 * Row 2 (context strip): 4 supporting stats — total years filed,
 *   cumulative earnings, cumulative tax, and cumulative effective
 *   rate. These frame the hero: is this year's rate typical, or an
 *   outlier vs the multi-year average?
 *
 * Design choices
 * ──────────────
 * • Latest year selected as the newest AY row that is either an
 *   original (no revised sibling) or the revised itself. Skips
 *   originals when a revised exists — the revised is the current
 *   truth.
 * • Effective rate denominator = gross_salary + income_other_sources,
 *   matching the ₹100-earned framing (see lib/filings.ts).
 */
export function FilingsHeadline({
  returns,
  cumulative,
}: {
  returns: ItrReturn[];
  cumulative: FilingsCumulative;
}) {
  // Pick the canonical latest row — revised wins over original for
  // the same AY. `returns` is sorted ASC by AY then is_revised, so
  // the LAST element of the max-AY group is the canonical latest.
  const revisedAys = new Set(
    returns.filter((r) => r.is_revised).map((r) => r.assessment_year)
  );
  const canonical = returns.filter(
    (r) => r.is_revised || !revisedAys.has(r.assessment_year)
  );
  const latest = canonical[canonical.length - 1];

  const latestRate = latest ? effectiveRatePct(latest) : 0;
  const latestKept = 100 - latestRate;

  return (
    <div className="flex flex-col gap-4">
      {/* Row 1 — hero */}
      <Card className="p-6">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Latest · AY {latest?.assessment_year ?? "—"} · {latest?.regime.toUpperCase() ?? ""}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span className="text-4xl font-bold tabular-nums text-foreground">
            ₹{latestKept.toFixed(2)}
          </span>
          <span className="text-base text-muted-foreground">
            kept of every ₹100 earned
          </span>
          <span className="ml-auto text-sm font-semibold tabular-nums text-[hsl(var(--danger))]">
            ₹{latestRate.toFixed(2)} to tax
          </span>
        </div>
        {latest && (
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <span>
              Gross{" "}
              <span className="text-foreground">{fmtL(latest.gross_salary + latest.income_other_sources)}</span>
            </span>
            <span>
              Tax paid{" "}
              <span className="text-foreground">{fmtL(latest.total_tax_liability)}</span>
            </span>
            <span>
              TDS{" "}
              <span className="text-foreground">{fmtL(latest.tds_salary + latest.tds_other)}</span>
            </span>
            {latest.self_assessment_tax > 0 && (
              <span>
                SAT{" "}
                <span className="text-foreground">{fmtINR(latest.self_assessment_tax)}</span>
              </span>
            )}
            {latest.refund_due > 0 && (
              <span className="text-[hsl(var(--success))]">
                Refund {fmtINR(latest.refund_due)}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Row 2 — multi-year context */}
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ContextStat
            label={`${cumulative.years}-year total`}
            value={fmtL(cumulative.totalGrossEarned)}
            hint="gross earned"
          />
          <ContextStat
            label={`${cumulative.years}-year total`}
            value={fmtL(cumulative.totalTaxPaid)}
            hint="tax paid"
          />
          <ContextStat
            label="Overall rate"
            value={`₹${cumulative.overallEffectiveRate.toFixed(2)}`}
            hint="per ₹100 earned"
            tone="danger"
          />
          <ContextStat
            label="Overall kept"
            value={`₹${(100 - cumulative.overallEffectiveRate).toFixed(2)}`}
            hint="per ₹100 earned"
            tone="success"
          />
        </div>
      </Card>
    </div>
  );
}

function ContextStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "success" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "text-[hsl(var(--danger))]"
      : tone === "success"
        ? "text-[hsl(var(--success))]"
        : "text-foreground";
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${toneClass}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
