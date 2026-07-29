"use client";

import { useState, useTransition } from "react";
import {
  TrendingUp,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { saveNpsContribution } from "@/app/actions";
import type { NpsState } from "@/lib/queries";

/**
 * NPS "default monthly amount" card on Settings.
 *
 * ── Scope after log-credit consolidation ─────────────────────────────
 * The "Log an NPS payroll credit" form that used to live here moved to
 * /sync (components/sync/LogCreditEventCard.tsx) — that's now the single
 * place for logging real NPS credits into the ledger.
 *
 * This card retains ONLY the "default monthly amount" placeholder. It
 * does two things:
 *
 *   1. Persists the number so future forecasting / cadence tooling can
 *      read it from `nps_state.monthly_contribution_inr`.
 *   2. Pre-fills the amount hint on the Sync-page log form via
 *      LogCreditEventCard's placeholder helper. Updating the amount here
 *      changes what "the next credit is probably this amount" hint
 *      shows over there.
 *
 * The actual E:C:G alloc split lives on `nps_state.alloc_*_pct` and is
 * displayed here as a read-only info banner so users know how credits
 * they log will be fanned across schemes.
 */
export function NpsContribCard({ nps }: { nps: NpsState | null }) {
  const [contrib, setContrib] = useState<string>(
    nps ? String(nps.monthly_contribution_inr) : ""
  );
  const [pendingSave, startSave] = useTransition();
  const [saveFeedback, setSaveFeedback] = useState<
    { ok: boolean; text: string } | null
  >(null);

  function submitSave() {
    setSaveFeedback(null);
    const n = Number(contrib);
    if (!Number.isFinite(n) || n <= 0) {
      setSaveFeedback({ ok: false, text: "Enter a positive amount" });
      return;
    }
    startSave(async () => {
      const res = await saveNpsContribution({ monthly_contribution_inr: n });
      setSaveFeedback(
        res.ok
          ? {
              ok: true,
              text:
                "Default amount saved — used as the placeholder on the Sync-page log form.",
            }
          : { ok: false, text: res.error }
      );
    });
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(280_65%_70%/0.15)] text-[hsl(280_65%_70%)]">
          <TrendingUp size={14} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            NPS monthly contribution
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Default amount only — log real credits on the{" "}
            <a
              href="/sync#log-credit"
              className="text-primary underline-offset-2 hover:underline"
            >
              Sync page
            </a>
            .
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Default monthly amount (₹)
          </label>
          <Input
            type="number"
            value={contrib}
            onChange={(e) => setContrib(e.target.value)}
            placeholder="15,076"
          />
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          Real credits split E:C:G at{" "}
          <span className="text-foreground">
            {nps
              ? `${nps.alloc_e_pct}:${nps.alloc_c_pct}:${nps.alloc_g_pct}`
              : "—"}
          </span>{" "}
          using the day's current NAV
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
            {pendingSave ? "Saving…" : "Save amount"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
