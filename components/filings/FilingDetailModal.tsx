"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { fmtINR, fmtL } from "@/lib/utils";
import type { ItrReturn } from "@/lib/filings-types";
import { effectiveRatePct } from "@/lib/filings-types";

/**
 * Filing deep-dive modal
 * ======================
 *
 * Opens when a row in FilingsTable is clicked. Shows the full computed
 * return for that (AY, revised?) — the summary row only exposes ~8
 * facts, but the schema captures ~40. This modal is where those extra
 * facts live so the table stays scannable.
 *
 * Structure follows the actual mental model of an ITR — the same
 * top-to-bottom flow you'd trace through Form 16 + Schedule VIA + the
 * tax-payable computation:
 *
 *   1. Header strip  — identity, filing metadata, effective rate
 *   2. Income        — gross → exempt → net → +OS → GTI → −ChVIA → TI
 *   3. Deductions    — Chapter VIA breakdown (non-zero only)
 *   4. Tax comp      — tax on TI → 87A → +cess → +234s → +234F → total
 *   5. Payments      — TDS split + AT + SAT + TCS
 *   6. Outcome       — refund or balance
 *   7. Other sources — if the JSONB breakdown has entries
 *   8. Provenance    — form / section / source / digest
 *
 * Dismiss idiom (backdrop click, ESC key, close button, body scroll
 * lock) intentionally mirrors SectorDetailModal / FundDetailsModal so
 * every drill-down in the app feels the same.
 */
export function FilingDetailModal({
  ret,
  onClose,
}: {
  ret: ItrReturn | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!ret) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [ret, onClose]);

  if (!ret) return null;

  const rate = effectiveRatePct(ret);
  const gross = ret.gross_salary + ret.income_other_sources;
  const netSalary =
    ret.net_salary || Math.max(0, ret.gross_salary - ret.section10_exempt);
  const daysFromDue = filingDelta(ret.json_creation_date, ret.filing_due_date);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="filing-modal-title"
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close filing details"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="border-b border-border p-5 pr-14">
          <div className="kicker mb-1">
            {ret.form_name}
            {ret.is_revised ? " · revised" : " · original"}
            {ret.return_file_sec ? ` · §139(${sectionSuffix(ret.return_file_sec)})` : ""}
          </div>
          <h2
            id="filing-modal-title"
            className="text-2xl font-bold tracking-tight text-foreground"
          >
            AY {ret.assessment_year}{" "}
            <span className="text-lg font-medium text-muted-foreground">
              (FY {ret.financial_year})
            </span>
          </h2>
          <div className="mt-1 text-xs text-muted-foreground">
            Regime: <span className="font-medium uppercase text-foreground">{ret.regime}</span>
            {ret.employer_names.length > 0 && (
              <>
                {" · "}
                {ret.employer_names.map((e) => e.name).join(" · ")}
              </>
            )}
          </div>

          {/* Big-number strip: gross earned, effective rate, outcome */}
          <div className="mt-4 grid grid-cols-3 gap-4">
            <BigStat
              kicker="Gross earned"
              value={fmtL(gross)}
              helper={`salary ${fmtL(ret.gross_salary)}${ret.income_other_sources > 0 ? ` · OS ${fmtINR(ret.income_other_sources)}` : ""}`}
            />
            <BigStat
              kicker="Effective rate"
              value={`₹${rate.toFixed(2)} / ₹100`}
              accent="danger"
              helper="of gross earned"
            />
            <BigStat
              kicker="Outcome"
              value={
                ret.refund_due > 0
                  ? `+${fmtINR(ret.refund_due)}`
                  : ret.balance_tax_payable > 0
                    ? `−${fmtINR(ret.balance_tax_payable)}`
                    : "settled"
              }
              accent={
                ret.refund_due > 0
                  ? "success"
                  : ret.balance_tax_payable > 0
                    ? "danger"
                    : "muted"
              }
              helper={
                ret.refund_due > 0
                  ? "refund from CBDT"
                  : ret.balance_tax_payable > 0
                    ? "balance payable"
                    : "nothing owed"
              }
            />
          </div>
        </div>

        {/* ── Scrollable body ────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="Income waterfall">
            <WaterfallRow label="Gross salary" value={ret.gross_salary} />
            {ret.perquisites_value > 0 && (
              <WaterfallRow
                label="Perquisites"
                value={ret.perquisites_value}
                sub
                note="included in gross"
              />
            )}
            {ret.section10_exempt > 0 && (
              <WaterfallRow
                label="Section 10 exempt (HRA/LTA)"
                value={-ret.section10_exempt}
                op="−"
              />
            )}
            <WaterfallRow label="Net salary" value={netSalary} subtotal />
            {ret.std_deduction_16ia > 0 && (
              <WaterfallRow
                label="Standard deduction §16(ia)"
                value={-ret.std_deduction_16ia}
                op="−"
              />
            )}
            <WaterfallRow
              label="Income from salary"
              value={ret.income_from_salary}
              subtotal
            />
            {ret.income_other_sources > 0 && (
              <WaterfallRow
                label="Income from other sources"
                value={ret.income_other_sources}
                op="+"
              />
            )}
            <WaterfallRow
              label="Gross total income"
              value={ret.gross_total_income}
              subtotal
            />
            {ret.chapter_via_deductions > 0 && (
              <WaterfallRow
                label="Chapter VI-A deductions"
                value={-ret.chapter_via_deductions}
                op="−"
              />
            )}
            <WaterfallRow
              label="Total (taxable) income"
              value={ret.total_income}
              total
            />
          </Section>

          {hasDeductions(ret) && (
            <Section title="Chapter VI-A breakdown">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                {ret.sec_80c > 0 && <KV label="§80C" value={ret.sec_80c} />}
                {ret.sec_80ccd_employee > 0 && (
                  <KV label="§80CCD(1) — self NPS" value={ret.sec_80ccd_employee} />
                )}
                {ret.sec_80ccd_1b > 0 && (
                  <KV label="§80CCD(1B) — NPS extra" value={ret.sec_80ccd_1b} />
                )}
                {ret.sec_80ccd_employer > 0 && (
                  <KV
                    label="§80CCD(2) — employer NPS"
                    value={ret.sec_80ccd_employer}
                    note="only lever under new regime"
                  />
                )}
                {ret.sec_80d > 0 && <KV label="§80D — health" value={ret.sec_80d} />}
                {ret.sec_80g > 0 && <KV label="§80G — donations" value={ret.sec_80g} />}
                {ret.sec_80tta > 0 && (
                  <KV label="§80TTA — savings int" value={ret.sec_80tta} />
                )}
              </div>
            </Section>
          )}

          <Section title="Tax computation">
            <WaterfallRow label="Tax on total income" value={ret.tax_on_total_income} />
            {ret.rebate_87a > 0 && (
              <WaterfallRow label="Rebate §87A" value={-ret.rebate_87a} op="−" />
            )}
            {ret.education_cess > 0 && (
              <WaterfallRow label="Health & education cess (4%)" value={ret.education_cess} op="+" />
            )}
            <WaterfallRow
              label="Gross tax liability"
              value={ret.gross_tax_liability}
              subtotal
            />
            {ret.interest_234a > 0 && (
              <WaterfallRow label="Interest §234A (late filing)" value={ret.interest_234a} op="+" />
            )}
            {ret.interest_234b > 0 && (
              <WaterfallRow
                label="Interest §234B (AT shortfall)"
                value={ret.interest_234b}
                op="+"
              />
            )}
            {ret.interest_234c > 0 && (
              <WaterfallRow
                label="Interest §234C (AT deferment)"
                value={ret.interest_234c}
                op="+"
              />
            )}
            {ret.late_fee_234f > 0 && (
              <WaterfallRow label="Late fee §234F" value={ret.late_fee_234f} op="+" />
            )}
            <WaterfallRow
              label="Total tax liability"
              value={ret.total_tax_liability}
              total
            />
          </Section>

          <Section title="How the tax was paid">
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              {ret.tds_salary > 0 && (
                <KV label="TDS — salary" value={ret.tds_salary} />
              )}
              {ret.tds_other > 0 && (
                <KV label="TDS — other" value={ret.tds_other} />
              )}
              {ret.advance_tax > 0 && (
                <KV label="Advance tax" value={ret.advance_tax} />
              )}
              {ret.self_assessment_tax > 0 && (
                <KV
                  label="Self-assessment tax"
                  value={ret.self_assessment_tax}
                  accent="warning"
                  note="topped up at filing"
                />
              )}
              {ret.tcs > 0 && <KV label="TCS" value={ret.tcs} />}
            </div>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-sm font-medium text-foreground">Total paid</span>
              <span className="text-base font-semibold tabular-nums text-foreground">
                {fmtL(ret.total_taxes_paid)}
              </span>
            </div>
          </Section>

          {ret.other_income_breakdown.length > 0 && (
            <Section title="Other-source income breakdown">
              <div className="space-y-1.5 text-sm">
                {ret.other_income_breakdown.map((row, idx) => (
                  <div key={idx} className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">
                      {osDescLabel(row.desc)}
                    </span>
                    <span className="tabular-nums text-foreground">
                      {fmtINR(row.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Filing & provenance" muted>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
              <MetaRow label="Filed on" value={ret.json_creation_date ?? "—"} />
              <MetaRow
                label="Due date"
                value={ret.filing_due_date ?? "—"}
                note={daysFromDue}
              />
              <MetaRow label="Form" value={ret.form_name} />
              <MetaRow
                label="Return type"
                value={
                  ret.return_file_sec
                    ? `§139(${sectionSuffix(ret.return_file_sec)})`
                    : "—"
                }
              />
              <MetaRow label="Schema version" value={ret.schema_version ?? "—"} />
              <MetaRow label="Source" value={ret.source_file ?? "—"} mono />
              {ret.json_digest && (
                <MetaRow
                  label="Digest"
                  value={`${ret.json_digest.slice(0, 12)}…`}
                  mono
                />
              )}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function Section({
  title,
  children,
  muted,
}: {
  title: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={
        "border-b border-border/60 px-5 py-4 last:border-b-0 " +
        (muted ? "bg-muted/20" : "")
      }
    >
      <div className="kicker mb-3">{title}</div>
      {children}
    </div>
  );
}

function BigStat({
  kicker,
  value,
  helper,
  accent = "default",
}: {
  kicker: string;
  value: string;
  helper?: string;
  accent?: "default" | "success" | "danger" | "warning" | "muted";
}) {
  const accentClass =
    accent === "success"
      ? "text-[hsl(var(--success))]"
      : accent === "danger"
        ? "text-[hsl(var(--danger))]"
        : accent === "warning"
          ? "text-[hsl(var(--warning))]"
          : accent === "muted"
            ? "text-muted-foreground"
            : "text-foreground";
  return (
    <div className="min-w-0">
      <div className="kicker">{kicker}</div>
      <div className={"mt-1 truncate text-xl font-semibold tabular-nums " + accentClass}>
        {value}
      </div>
      {helper && (
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {helper}
        </div>
      )}
    </div>
  );
}

function WaterfallRow({
  label,
  value,
  op,
  sub,
  subtotal,
  total,
  note,
}: {
  label: string;
  value: number;
  op?: "+" | "−";
  sub?: boolean;
  subtotal?: boolean;
  total?: boolean;
  note?: string;
}) {
  const isNeg = value < 0;
  const shown = Math.abs(value);

  const rowCls = total
    ? "border-t border-border pt-2 mt-1 font-semibold text-foreground"
    : subtotal
      ? "text-foreground"
      : sub
        ? "text-muted-foreground text-xs"
        : "text-foreground";

  return (
    <div className={"flex items-baseline justify-between py-1 text-sm " + rowCls}>
      <div className="flex items-baseline gap-2">
        {op && !subtotal && !total && (
          <span
            className={
              "inline-block w-3 text-center font-mono " +
              (op === "−" ? "text-[hsl(var(--danger))]" : "text-[hsl(var(--success))]")
            }
          >
            {op}
          </span>
        )}
        {!op && !subtotal && !total && <span className="inline-block w-3" />}
        <span>{label}</span>
        {note && (
          <span className="text-[10px] text-muted-foreground">({note})</span>
        )}
      </div>
      <span className={"tabular-nums " + (isNeg ? "text-[hsl(var(--danger))]" : "")}>
        {sub ? fmtINR(shown) : fmtL(shown)}
      </span>
    </div>
  );
}

function KV({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: number;
  note?: string;
  accent?: "warning";
}) {
  const accentCls =
    accent === "warning" ? "text-[hsl(var(--warning))]" : "text-foreground";
  return (
    <div className="flex items-baseline justify-between border-b border-border/40 py-1 last:border-b-0">
      <div>
        <span className="text-muted-foreground">{label}</span>
        {note && (
          <span className="ml-1 text-[10px] text-muted-foreground/80">
            · {note}
          </span>
        )}
      </div>
      <span className={"tabular-nums font-medium " + accentCls}>
        {fmtINR(value)}
      </span>
    </div>
  );
}

function MetaRow({
  label,
  value,
  note,
  mono,
}: {
  label: string;
  value: string;
  note?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right">
        <div className={"truncate text-foreground " + (mono ? "font-mono text-[11px]" : "")}>
          {value}
        </div>
        {note && (
          <div className="text-[10px] text-muted-foreground">{note}</div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function hasDeductions(r: ItrReturn): boolean {
  return (
    r.sec_80c > 0 ||
    r.sec_80ccd_employee > 0 ||
    r.sec_80ccd_1b > 0 ||
    r.sec_80ccd_employer > 0 ||
    r.sec_80d > 0 ||
    r.sec_80g > 0 ||
    r.sec_80tta > 0
  );
}

function sectionSuffix(code: number): string {
  // ITR ReturnFileSec codes → the §139 sub-section they represent.
  // 11 = 139(1) original / on-time
  // 12 = 139(4) belated
  // 17 = 139(5) revised
  // 18 = 139(8A) updated (ITR-U)
  if (code === 11) return "1";
  if (code === 12) return "4";
  if (code === 17) return "5";
  if (code === 18) return "8A";
  return String(code);
}

function filingDelta(
  filed: string | null | undefined,
  due: string | null | undefined
): string | undefined {
  if (!filed || !due) return undefined;
  const f = new Date(filed);
  const d = new Date(due);
  const days = Math.round((f.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "on due date";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} late`;
  return `${Math.abs(days)} day${days === -1 ? "" : "s"} early`;
}

function osDescLabel(desc: string): string {
  // ITR uses opaque 3-letter codes for the OS breakdown.
  // Translate the common ones; unknown codes render as-is.
  const map: Record<string, string> = {
    SAV: "Savings account interest",
    IFD: "Fixed deposit interest",
    DIV: "Dividends",
    TAX: "Interest on IT refund",
    OTH: "Other",
  };
  return map[desc.toUpperCase()] ?? desc;
}
