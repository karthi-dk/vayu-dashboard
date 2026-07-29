"use client";

import { useState, useTransition } from "react";
import {
  BookOpen,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn, fmtDate, fmtINR } from "@/lib/utils";
import { logRetirementCredit } from "@/app/actions";
import type {
  CreditSource,
  CreditType,
  EpfState,
  NpsState,
} from "@/lib/queries";

// Form-local state, kept as strings until submit-time validation. Amount
// stays a string so an empty input renders as "" (not 0) — the placeholder
// then remains visible until the user types.
type FormState = {
  source: CreditSource;
  credit_date: string;
  credit_type: CreditType;
  amount_inr: string;
  note: string;
};

/**
 * Source × type → amount placeholder helper.
 *
 * Uses live state from `epf_state` / `nps_state` when available so the
 * hint reflects the user's actual cadence rather than a hardcoded
 * constant. Falls back to a sensible default only when the state row is
 * missing (brand-new install, migration pending, etc.).
 *
 * Historical anchors (mirrors what EpfCard / NpsContribCard used to hint
 * before consolidation) — kept so the fallback is realistic rather than
 * "0" which would train the user to type past a broken placeholder.
 */
function placeholderFor(
  source: CreditSource,
  type: CreditType,
  epf: EpfState | null,
  nps: NpsState | null
): string {
  if (source === "EPF") {
    if (type === "interest") {
      // Annual EPFO interest credit. Prefer the user's last real interest
      // number if we have one — that's a much better hint than a
      // hardcoded historical value that goes stale year after year.
      return epf?.last_interest_credit_amount_inr != null
        ? fmtINR(epf.last_interest_credit_amount_inr)
        : "1,18,899";
    }
    return epf?.monthly_contribution_inr
      ? fmtINR(epf.monthly_contribution_inr)
      : "34,932";
  }
  // NPS — only "payroll" ever hits this path (interest is disabled in
  // the type dropdown when source=NPS), so we don't branch on type.
  return nps?.monthly_contribution_inr
    ? fmtINR(nps.monthly_contribution_inr)
    : "15,076";
}

/**
 * Sync-page card for logging retirement corpus events (EPF/NPS payroll
 * credits, EPF interest). Records to the retirement ledger AND updates
 * the corpus atomically. The action, validation rules, and DB unique
 * constraint are shared with the /credits page's ledger view.
 *
 * Belongs on Sync because it's a data-ingestion action, alongside the
 * other paste/refresh cards. /credits is now purely a viewing surface.
 *
 * ── Enriched from Settings-page predecessors ──────────────────────────
 * Previously, EpfCard and NpsContribCard on the Settings page each
 * carried their own log-credit form. This card is the consolidated
 * replacement, so it deliberately preserves the two affordances that
 * would otherwise be lost:
 *
 *   1. Source+type-aware amount placeholder — reads live state instead
 *      of a static "0". A user seeing "34,932" or "1,18,899" gets a
 *      strong hint about what to type next.
 *   2. NPS split confirmation — the success message includes the
 *      current E:C:G alloc split so the user immediately sees how their
 *      credit will be allocated across the three NPS schemes (the log
 *      action does the actual unit math server-side using this same
 *      alloc).
 */
export function LogCreditEventCard({
  epf = null,
  nps = null,
}: {
  epf?: EpfState | null;
  nps?: NpsState | null;
}) {
  // ISO YYYY-MM-DD in the client's locale. Fine for IST users; a user
  // in a different TZ might see yesterday as default, which is a
  // trivial trade-off for keeping this a pure client component.
  const todayIso = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<FormState>({
    source: "EPF",
    credit_date: todayIso,
    credit_type: "payroll",
    amount_inr: "",
    note: "",
  });
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // "Interest" is EPF-only in our schema; disable it in the dropdown
  // when NPS is selected so we don't have to bounce the user with an
  // error post-submit.
  const disallowInterest = form.source === "NPS";
  const amountPlaceholder = placeholderFor(
    form.source,
    form.credit_type,
    epf,
    nps
  );

  function submit() {
    setFeedback(null);
    const amt = Number(form.amount_inr);
    if (!Number.isFinite(amt) || amt <= 0) {
      setFeedback({ ok: false, text: "Amount must be positive" });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.credit_date)) {
      setFeedback({ ok: false, text: "Pick a valid date" });
      return;
    }
    if (form.credit_type === "interest" && form.source !== "EPF") {
      setFeedback({ ok: false, text: "Interest applies only to EPF" });
      return;
    }
    startTransition(async () => {
      const res = await logRetirementCredit({
        source: form.source,
        credit_date: form.credit_date,
        credit_type: form.credit_type,
        amount_inr: amt,
        note: form.note.trim() || null,
      });
      if (res.ok) {
        // Base confirmation — always shows source/type/amount/date so
        // the user can eyeball for typos before moving on. NPS payroll
        // additionally spells out the E:C:G split because the log
        // action silently fans the amount across three schemes at
        // current NAV, and that unit math is invisible on this page.
        const splitTail =
          form.source === "NPS" && form.credit_type === "payroll" && nps
            ? ` · Units split E:C:G ${nps.alloc_e_pct}:${nps.alloc_c_pct}:${nps.alloc_g_pct} at current NAV`
            : "";
        setFeedback({
          ok: true,
          text: `Logged +${fmtINR(amt)} ${form.source} ${
            form.credit_type
          } on ${fmtDate(form.credit_date)}${splitTail}`,
        });
        // Amount + note reset so the user can log the next entry
        // fast; source/type/date stick so back-to-back months of the
        // same type are one field to change.
        setForm((f) => ({ ...f, amount_inr: "", note: "" }));
      } else {
        setFeedback({ ok: false, text: res.error });
      }
    });
  }

  return (
    // id anchors the "Log it on Sync" deep-link from the Credits page
    // nudge so the user lands right on this card, not the page top.
    <Card id="log-credit" className="scroll-mt-6 p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]">
          <BookOpen size={14} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Log EPF / NPS credit event
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Records to the retirement ledger AND updates the corpus
            atomically. Use monthly when the EPFO SMS lands or the NPS
            statement drops. Duplicate{" "}
            <code className="rounded bg-muted/50 px-1 text-[10px]">
              (source, date, type)
            </code>{" "}
            is blocked at the DB level.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Source
          </label>
          <select
            value={form.source}
            onChange={(e) => {
              const source = e.target.value as CreditSource;
              setForm((f) => ({
                ...f,
                source,
                credit_type:
                  source === "NPS" && f.credit_type === "interest"
                    ? "payroll"
                    : f.credit_type,
              }));
            }}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="EPF">EPF</option>
            <option value="NPS">NPS</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Type
          </label>
          <select
            value={form.credit_type}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                credit_type: e.target.value as CreditType,
              }))
            }
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="payroll">Payroll</option>
            <option value="interest" disabled={disallowInterest}>
              Interest {disallowInterest ? "(EPF only)" : ""}
            </option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Credit date
          </label>
          <Input
            type="date"
            value={form.credit_date}
            max={todayIso}
            onChange={(e) =>
              setForm((f) => ({ ...f, credit_date: e.target.value }))
            }
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Amount (₹)
          </label>
          <Input
            type="number"
            value={form.amount_inr}
            onChange={(e) =>
              setForm((f) => ({ ...f, amount_inr: e.target.value }))
            }
            placeholder={amountPlaceholder}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Note (optional)
          </label>
          <Input
            type="text"
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="e.g., Jun-26 dues"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-h-[16px] flex-1 text-xs">
          {feedback && (
            <div
              className={cn(
                "flex items-center gap-1.5",
                feedback.ok
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              )}
            >
              {feedback.ok ? (
                <CheckCircle2 size={12} />
              ) : (
                <AlertTriangle size={12} />
              )}
              {feedback.text}
            </div>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={pending}
        >
          {pending && <Loader2 size={12} className="animate-spin" />}
          {pending ? "Logging…" : "Log credit"}
        </Button>
      </div>
    </Card>
  );
}
