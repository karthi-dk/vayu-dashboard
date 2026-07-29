"use client";

import { useMemo, useState, useTransition } from "react";
import {
  PiggyBank,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { fmtDate, fmtINR } from "@/lib/utils";
import { saveNpsUnits } from "@/app/actions";
import type { NpsState } from "@/lib/queries";

export function NpsUnitsCard({ nps }: { nps: NpsState | null }) {
  const [e, setE] = useState<string>(nps ? String(nps.scheme_e_units) : "");
  const [c, setC] = useState<string>(nps ? String(nps.scheme_c_units) : "");
  const [g, setG] = useState<string>(nps ? String(nps.scheme_g_units) : "");
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<
    { ok: boolean; text: string } | null
  >(null);

  const projected = useMemo(() => {
    if (!nps) return 0;
    const eV = Number(e) * nps.scheme_e_nav;
    const cV = Number(c) * nps.scheme_c_nav;
    const gV = Number(g) * nps.scheme_g_nav;
    return Number.isFinite(eV + cV + gV) ? eV + cV + gV : 0;
  }, [e, c, g, nps]);

  function submit() {
    setFeedback(null);
    const eN = Number(e);
    const cN = Number(c);
    const gN = Number(g);
    if (![eN, cN, gN].every(Number.isFinite)) {
      setFeedback({ ok: false, text: "Enter valid unit counts for all 3 schemes" });
      return;
    }
    start(async () => {
      const res = await saveNpsUnits({
        scheme_e_units: eN,
        scheme_c_units: cN,
        scheme_g_units: gN,
      });
      setFeedback(
        res.ok
          ? { ok: true, text: "Units saved. NAV cron will value them daily." }
          : { ok: false, text: res.error }
      );
    });
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(200_80%_65%/0.15)] text-[hsl(200_80%_65%)]">
          <PiggyBank size={14} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            NPS units (Tier-I)
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Copy the 3 scheme unit counts from CRA once a month
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {[
          {
            label: "Scheme E (Equity 75%)",
            value: e,
            set: setE,
            nav: nps?.scheme_e_nav,
          },
          {
            label: "Scheme C (Corp bonds 20%)",
            value: c,
            set: setC,
            nav: nps?.scheme_c_nav,
          },
          {
            label: "Scheme G (Govt bonds 5%)",
            value: g,
            set: setG,
            nav: nps?.scheme_g_nav,
          },
        ].map((row) => (
          <div key={row.label}>
            <label className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{row.label}</span>
              <span className="font-mono text-[10px]">
                NAV ₹{row.nav?.toFixed(4) ?? "—"}
              </span>
            </label>
            <Input
              type="number"
              step="0.0001"
              value={row.value}
              onChange={(ev) => row.set(ev.target.value)}
              placeholder="Units"
            />
          </div>
        ))}

        <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
          <div className="kicker mb-1">Projected corpus at current NAV</div>
          <div className="font-semibold text-foreground">
            {fmtINR(projected)}
          </div>
          <div className="mt-1 text-muted-foreground">
            Last updated{" "}
            <span className="text-foreground">
              {fmtDate(nps?.last_units_update ?? null)}
            </span>
          </div>
        </div>

        {feedback && (
          <div
            className={
              feedback.ok
                ? "flex items-center gap-2 text-xs text-[hsl(var(--success))]"
                : "flex items-center gap-2 text-xs text-[hsl(var(--danger))]"
            }
          >
            {feedback.ok ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertTriangle size={12} />
            )}
            {feedback.text}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={pending}
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            {pending ? "Saving…" : "Save units"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
