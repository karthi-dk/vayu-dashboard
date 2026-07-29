"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RefreshCw, LineChart as LineChartIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { fmtDateShort } from "@/lib/utils";
import type { IndexLevelRow } from "@/lib/queries";

type Props = {
  indexLevels: IndexLevelRow[];
};

/**
 * Refresh index levels card
 * ==========================
 *
 * Manual-trigger card for /api/refresh-index-levels — fetches full daily
 * history for the six tracked indices from Yahoo Finance and recomputes
 * current / ATH / 52w-high / 3m-high for each. See
 * lib/indexLevels/yahooClient.ts for the data-source rationale.
 *
 * Deliberately its own card rather than folded into RefreshNavsCard —
 * this refreshes a completely different asset class (market indices, not
 * owned holdings) on a different upstream (Yahoo, not AMFI/Kotak), and
 * the refresh cadence is expected to be far less frequent (weekly/
 * monthly click, not daily).
 */
export function RefreshIndexLevelsCard({ indexLevels }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "success" | "partial" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  const latestUpdatedAt = indexLevels.reduce<string | null>(
    (max, r) => (max === null || r.updated_at > max ? r.updated_at : max),
    null
  );

  async function refresh() {
    setState("loading");
    setMessage(null);
    try {
      const resp = await fetch("/api/refresh-index-levels", { method: "POST" });
      const body = await resp.json();
      if (!resp.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${resp.status}`);
      }
      setMessage(body.message as string);
      setState(body.failed > 0 ? "partial" : "success");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  const isLoading = state === "loading";
  const dotColor: "success" | "warning" | "danger" = isLoading
    ? "warning"
    : state === "error"
      ? "danger"
      : state === "partial"
        ? "warning"
        : state === "success"
          ? "success"
          : latestUpdatedAt
            ? "success"
            : "warning";

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <LineChartIcon size={16} />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Refresh index highs
              </h3>
              <p className="mt-0.5 kicker">
                N50 · NN50 · Mid150 · Small250 · Nasdaq100 · S&amp;P500 — ATH / 52w / 3m
              </p>
            </div>
            <Button
              onClick={refresh}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5"
            >
              {isLoading ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Fetching…
                </>
              ) : (
                <>
                  <RefreshCw size={13} />
                  Refresh
                </>
              )}
            </Button>
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[11px]">
            <PulseDot color={dotColor} />
            <span className="text-muted-foreground">
              {latestUpdatedAt ? (
                <>
                  Last refreshed <TimeAgo isoDate={latestUpdatedAt} /> · {indexLevels.length}
                  /6 indices
                </>
              ) : (
                "Never refreshed — click Refresh to pull all six indices"
              )}
            </span>
          </div>

          {indexLevels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              {indexLevels.map((r) => (
                <span key={r.index_code} title={`Data as of ${fmtDateShort(r.as_of_date)}`}>
                  {r.display_name}: {fmtDateShort(r.as_of_date)}
                </span>
              ))}
            </div>
          )}

          {message && (
            <div
              className={
                state === "error"
                  ? "mt-3 rounded-md border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--danger))]"
                  : state === "partial"
                    ? "mt-3 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--warning))]"
                    : "mt-3 rounded-md border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--success))]"
              }
            >
              {message}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
