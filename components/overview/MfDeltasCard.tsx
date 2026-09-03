import { Card } from "@/components/ui/Card";
import { NwDeltasCards } from "@/components/overview/NwDeltasCards";
import type { NwDelta } from "@/lib/queries";

/**
 * MF-only period-returns grid — the same deposits-vs-growth window cards as
 * the net-worth strip, but computed off the reconstructed MF series. Shows as
 * many windows (1M → ALL) as the MF history reaches back to support.
 */
export function MfDeltasCard({ deltas }: { deltas: NwDelta[] }) {
  if (!deltas.some((d) => d.period !== "1D")) return null;
  return (
    <Card className="p-4 sm:p-5">
      <div className="text-sm font-semibold text-foreground">
        Mutual funds — period returns
      </div>
      <div className="mt-0.5 kicker">
        Each window split into what you added vs market growth
      </div>
      <NwDeltasCards deltas={deltas} />
    </Card>
  );
}
