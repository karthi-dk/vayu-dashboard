"use client";

import { useState, useTransition } from "react";
import {
  Wallet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { cn, fmtDate } from "@/lib/utils";
import { saveEpf } from "@/app/actions";
import type { EpfState } from "@/lib/queries";

/**
 * Staleness bands for the "Last verified" nudge.
 *
 * WHY THESE THRESHOLDS
 * --------------------
 * EPF is decided to be manually verified quarterly against
 * passbook.epfindia.gov.in. In the ledger-based model, balance_inr
 * accumulates via monthly credit events logged from the Sync page
 * (LogCreditEventCard). Manual verify still catches drift (job change
 * arrears, EPFO adjustments, rounding across many months).
 *
 *   < 100 days → fresh, no nudge (within the quarterly cadence)
 *   100–180d  → soft amber ("Passbook check due soon")
 *   ≥ 180 days → warning color ("Overdue")
 */
function computeVerifyStaleness(
  lastVerifiedDate: string | null | undefined
): {
  days: number | null;
  tone: "fresh" | "due-soon" | "overdue";
  message: string;
} {
  if (!lastVerifiedDate) {
    return {
      days: null,
      tone: "overdue",
      message: "No verify recorded yet — check passbook.epfindia.gov.in",
    };
  }
  const then = new Date(lastVerifiedDate + "T00:00:00Z").getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 100)
    return { days, tone: "fresh", message: `${days}d since last verify` };
  if (days < 180)
    return {
      days,
      tone: "due-soon",
      message: `${days}d since last verify — passbook check due soon`,
    };
  return {
    days,
    tone: "overdue",
    message: `${days}d since last verify — passbook check overdue`,
  };
}

/**
 * EPF drift-correction card on Settings.
 *
 * ── Scope after log-credit consolidation ─────────────────────────────
 * The "Log an EPF credit" form that used to live here moved to
 * /sync (components/sync/LogCreditEventCard.tsx) — that's now the
 * single place for logging real EPFO credits into the ledger.
 *
 * This card is the counterweight: use it ONLY to correct drift when
 * the manually-summed balance doesn't match the EPFO passbook (job
 * change arrears, rounding across many months, adjustments EPFO makes
 * behind the scenes). It writes `balance_inr` directly — bypassing the
 * ledger — which is deliberate: drift corrections shouldn't appear as
 * a fake "credit event" in the log.
 */
export function EpfCard({ epf }: { epf: EpfState | null }) {
  const [balance, setBalance] = useState<string>(
    epf ? String(epf.balance_inr) : ""
  );
  const [monthly, setMonthly] = useState<string>(
    epf ? String(epf.monthly_contribution_inr) : ""
  );
  const [pendingSave, startSave] = useTransition();
  const [saveFeedback, setSaveFeedback] = useState<
    { ok: boolean; text: string } | null
  >(null);

  function submitSave() {
    setSaveFeedback(null);
    const b = Number(balance);
    const m = Number(monthly);
    if (!Number.isFinite(b) || !Number.isFinite(m)) {
      setSaveFeedback({ ok: false, text: "Enter valid numbers" });
      return;
    }
    startSave(async () => {
      const res = await saveEpf({
        balance_inr: b,
        monthly_contribution_inr: m,
      });
      setSaveFeedback(
        res.ok
          ? { ok: true, text: "Saved. Next NW recompute will use this value." }
          : { ok: false, text: res.error }
      );
    });
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(160_60%_55%/0.15)] text-[hsl(160_60%_55%)]">
          <Wallet size={14} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            EPF balance &amp; contribution
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Passbook drift-check · Rate {epf?.interest_rate_pct ?? "—"}% p.a.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Current balance (₹)
          </label>
          <Input
            type="number"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="18,88,013"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Monthly contribution (₹)
          </label>
          <Input
            type="number"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            placeholder="34,932"
          />
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          Last verified{" "}
          <span className="text-foreground">
            {fmtDate(epf?.last_verified_date ?? null)}
          </span>{" "}
          · Log real credits on the{" "}
          <a
            href="/sync#log-credit"
            className="text-primary underline-offset-2 hover:underline"
          >
            Sync page
          </a>
          ; use Save changes here only to correct drift.
          {(() => {
            const s = computeVerifyStaleness(epf?.last_verified_date);
            if (s.tone === "fresh") return null;
            return (
              <div
                className={cn(
                  "mt-2 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px]",
                  s.tone === "due-soon"
                    ? "border-[hsl(45_85%_60%/0.3)] bg-[hsl(45_85%_60%/0.1)] text-[hsl(45_85%_60%)]"
                    : "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]"
                )}
              >
                <Clock size={11} />
                <span>{s.message}</span>
              </div>
            );
          })()}
        </div>

        {saveFeedback && (
          <div
            className={
              saveFeedback.ok
                ? "flex items-center gap-2 text-xs text-[hsl(var(--success))]"
                : "flex items-center gap-2 text-xs text-[hsl(var(--danger))]"
            }
          >
            {saveFeedback.ok ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertTriangle size={12} />
            )}
            {saveFeedback.text}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={submitSave}
            disabled={pendingSave}
          >
            {pendingSave && <Loader2 size={12} className="animate-spin" />}
            {pendingSave ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
