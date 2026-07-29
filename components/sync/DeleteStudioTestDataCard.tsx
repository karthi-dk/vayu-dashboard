"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { deleteStudioTestData } from "@/app/actions";

/**
 * Sync-page control to wipe Studio rehearsal rows
 * (`mf_transactions.platform = 'test'`). Those rows never touch
 * fund_holdings / nw_daily, so this is a safe ledger-only purge
 * after recording sessions.
 */
export function DeleteStudioTestDataCard({
  testTxCount,
}: {
  testTxCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(testTxCount);

  const onDelete = () => {
    const label =
      remaining === 1
        ? "1 test transaction"
        : `${remaining} test transactions`;
    if (
      !window.confirm(
        `Delete all ${label} (platform=test)? This cannot be undone.`
      )
    ) {
      return;
    }

    setState("idle");
    setMessage(null);
    startTransition(async () => {
      const result = await deleteStudioTestData();
      if (!result.ok) {
        setState("error");
        setMessage(result.error);
        return;
      }
      setRemaining(0);
      setState("success");
      setMessage(
        result.deleted === 0
          ? "No test rows to delete."
          : `Deleted ${result.deleted} test ${
              result.deleted === 1 ? "row" : "rows"
            }.`
      );
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-foreground">
            Studio test data
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Purge rehearsal{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">
              platform=test
            </code>{" "}
            rows from{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">
              mf_transactions
            </code>
            . Does not change holdings or headline math.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || remaining === 0}
          onClick={onDelete}
          className="shrink-0 border-[hsl(var(--danger)/0.35)] text-[hsl(var(--danger))] hover:bg-[hsl(var(--danger)/0.08)]"
        >
          {pending ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Trash2 size={14} aria-hidden />
          )}
          {pending ? "Deleting…" : "Delete all test data"}
        </Button>
      </CardHeader>
      <CardBody className="pt-0">
        <p className="text-xs text-muted-foreground">
          {remaining === 0
            ? "No test rows currently in the ledger."
            : `${remaining} test ${
                remaining === 1 ? "row" : "rows"
              } ready to delete.`}
        </p>
        {message && (
          <p
            className={`mt-2 flex items-center gap-1.5 text-xs ${
              state === "error"
                ? "text-[hsl(var(--danger))]"
                : "text-[hsl(var(--success))]"
            }`}
          >
            {state === "error" ? (
              <AlertTriangle size={12} aria-hidden />
            ) : (
              <CheckCircle2 size={12} aria-hidden />
            )}
            {message}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
