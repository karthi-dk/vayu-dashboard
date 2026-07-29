"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { fmtINR, fmtL } from "@/lib/utils";
import type { ItrReturn } from "@/lib/filings-types";
import { effectiveRatePct } from "@/lib/filings-types";
import { FilingDetailModal } from "./FilingDetailModal";

/**
 * Cross-year ITR table. One row per filed return, sorted latest-first.
 *
 * Column choices — what to show vs. what to keep for the drill-down:
 *   • AY + regime           — identity
 *   • Employer(s)           — narrative (who paid me)
 *   • Gross                 — salary + other income (the "earned" side)
 *   • Total tax             — Tax + Cess + 234A/B/C + 234F
 *   • ₹/₹100 earned         — THE metric the user asked for; own column
 *   • Taxes paid split      — TDS / AT / SAT — because chronic SAT ≠ 0
 *                             is a symptom the user should notice
 *   • Refund or balance     — outcome
 *   • Filed                 — date + "revised" tag
 *
 * Deliberately NOT shown (keeps the table scannable — 8 columns already):
 *   • Chapter VIA total     — visible in the deductions chart below
 *   • Std deduction         — mostly 50K/75K, uninteresting to compare
 *   • Section 10 exempt     — only lit up for AY 23-24, becomes a
 *                              compliance-flag callout instead of a
 *                              cell most rows show 0 in
 *
 * Revised returns render right after their original with a subtle
 * indent so the reader sees "these two rows describe the same AY".
 */
export function FilingsTable({ returns }: { returns: ItrReturn[] }) {
  const [selected, setSelected] = useState<ItrReturn | null>(null);

  // Sort DESC by AY so the newest year is on top. Within the same AY,
  // put the revised row directly under its original (revised sorts
  // AFTER original which sorts AFTER revised... just group them).
  const sorted = [...returns].sort((a, b) => {
    if (a.assessment_year !== b.assessment_year) {
      return a.assessment_year < b.assessment_year ? 1 : -1;
    }
    // Within same AY: original above revised (chronological amendment order)
    return a.is_revised ? 1 : -1;
  });

  return (
    <>
      <Card className="overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">
            Year-by-year filings
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {returns.length} return{returns.length === 1 ? "" : "s"} · sorted latest first · revised amendments indent under their original · click any row for the full return
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 text-left">AY</th>
                <th className="px-3 py-3 text-left">Employer(s)</th>
                <th className="px-3 py-3 text-right">Gross</th>
                <th className="px-3 py-3 text-right">Tax</th>
                <th className="px-3 py-3 text-right">₹/₹100</th>
                <th className="px-3 py-3 text-right">Paid</th>
                <th className="px-3 py-3 text-right">Outcome</th>
                <th className="px-5 py-3 text-left">Filed</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <FilingRow
                  key={`${r.assessment_year}-${r.is_revised}`}
                  r={r}
                  onSelect={() => setSelected(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <FilingDetailModal ret={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function FilingRow({ r, onSelect }: { r: ItrReturn; onSelect: () => void }) {
  const rate = effectiveRatePct(r);
  const gross = r.gross_salary + r.income_other_sources;
  const employerLabels = r.employer_names.map((e) => shortEmployer(e.name));
  const employerDisplay =
    employerLabels.length === 0
      ? "—"
      : employerLabels.length === 1
        ? employerLabels[0]
        : `${employerLabels[0]} +${employerLabels.length - 1}`;

  // Paid = TDS + AT + SAT — captures the shape of how the tax was
  // funded across the year. Split displayed as small helper text.
  const paidBreakdown: string[] = [];
  if (r.tds_salary + r.tds_other > 0) paidBreakdown.push(`TDS ${fmtL(r.tds_salary + r.tds_other)}`);
  if (r.advance_tax > 0) paidBreakdown.push(`AT ${fmtINR(r.advance_tax)}`);
  if (r.self_assessment_tax > 0) paidBreakdown.push(`SAT ${fmtINR(r.self_assessment_tax)}`);

  return (
    <tr
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open details for AY ${r.assessment_year}${r.is_revised ? " revised" : ""}`}
      className={
        "cursor-pointer border-t border-border/60 tabular-nums transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 " +
        (r.is_revised ? "bg-muted/30" : "")
      }
    >
      <td className="px-5 py-3 text-left">
        <div className={"font-medium " + (r.is_revised ? "pl-4 text-muted-foreground" : "text-foreground")}>
          {r.is_revised ? "↳ revised" : r.assessment_year}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {r.regime}
        </div>
      </td>
      <td className="px-3 py-3 text-left" title={r.employer_names.map((e) => e.name).join(" · ")}>
        <div className="text-foreground">{employerDisplay}</div>
      </td>
      <td className="px-3 py-3 text-right text-foreground">{fmtL(gross)}</td>
      <td className="px-3 py-3 text-right text-foreground">{fmtL(r.total_tax_liability)}</td>
      <td className="px-3 py-3 text-right">
        <span className="text-[hsl(var(--danger))] font-semibold">₹{rate.toFixed(2)}</span>
      </td>
      <td className="px-3 py-3 text-right">
        <div className="text-foreground">{fmtL(r.total_taxes_paid)}</div>
        {paidBreakdown.length > 0 && (
          <div className="text-[10px] text-muted-foreground">
            {paidBreakdown.join(" · ")}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right">
        {r.refund_due > 0 ? (
          <span className="text-[hsl(var(--success))]">+{fmtINR(r.refund_due)}</span>
        ) : r.balance_tax_payable > 0 ? (
          <span className="text-[hsl(var(--danger))]">−{fmtINR(r.balance_tax_payable)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-5 py-3 text-left text-muted-foreground">
        <div className="text-foreground">{r.json_creation_date ?? "—"}</div>
        {r.filing_due_date && (
          <div className="text-[10px]">due {r.filing_due_date}</div>
        )}
      </td>
    </tr>
  );
}

/**
 * Trim the CBDT-standard employer name style ("TVS NEXT LIMITED",
 * "NIKE INDIA TECHNOLOGY CENTER PRIVATE LIMITED") to something that
 * fits in a table cell without truncation eating the useful bit. Kept
 * inline because it's ITR-specific — mfLedger uses schemes with their
 * own naming convention.
 */
function shortEmployer(name: string): string {
  return name
    .replace(/\s*(PRIVATE|PVT|LIMITED|LTD|LLP)\s*/gi, " ")
    .replace(/\s+INDIA(\s+TECHNOLOGY\s+CENTER)?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
