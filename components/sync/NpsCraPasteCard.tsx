"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronRight, FileSpreadsheet, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";

/**
 * Protean CRA "Statement of Transactions" (SOT) HTML paste card.
 *
 * Complements the auto-derive path in logRetirementCredit: /credits
 * gives the chart approximate movement between statements, this
 * gives it authoritative CRA numbers whenever the user re-runs it
 * with the latest FY export. Ingest wipes any auto-derived rows in
 * the paste's date range first — see /api/sync-nps-cra for wipe
 * semantics.
 */

const MAX_LEN = 5 * 1024 * 1024; // 5 MB — one FY's SOT is ~50 KB, room for full history paste

const PLACEHOLDER = `<!-- Paste the FULL Protean CRA SOT HTML page here.
     From the CRA portal: Views → Statement of Transactions →
     select FY → View → Ctrl-U (view source) → Ctrl-A → Ctrl-C.
     Parser tolerates the standard Protean template plus a couple of
     minor variants. Pasting the same file twice is a no-op. -->
<html>
  <body>
    <table>...transaction table for FY 2025-26...</table>
  </body>
</html>`;

type IngestResponse = {
  ok?: true;
  message?: string;
  fy?: string;
  period?: { from: string; to: string };
  parsed?: {
    total_rows: number;
    contribution_count: number;
    contribution_amount: number;
    billing_count: number;
    billing_amount: number;
  };
  written?: {
    inserted: number;
    skipped_existing: number;
    auto_wiped: number;
  };
  warnings?: string[];
  error?: string;
};

export function NpsCraPasteCard() {
  const router = useRouter();
  const [html, setHtml] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing" | "success" | "error">(
    "idle"
  );
  const [result, setResult] = useState<IngestResponse | null>(null);

  const displayed = html || PLACEHOLDER;
  const isPlaceholder = !html;

  // Very light preview: sniff whether the paste looks like a CRA SOT
  // before we hit the API. Not a real parse — just a "does this
  // shape roughly match?" check so the user isn't guessing whether
  // their clipboard captured the whole page.
  const parseHint = useMemo(() => {
    if (!html.trim()) return null;
    const lower = html.toLowerCase();
    if (!lower.includes("<html") && !lower.includes("<table")) {
      return {
        ok: false,
        text: "Doesn't look like HTML — expected the full page source with <table> markup",
      };
    }
    const hasSotMarkers =
      lower.includes("statement of transactions") ||
      lower.includes("scheme e") ||
      lower.includes("scheme c") ||
      lower.includes("scheme g");
    if (!hasSotMarkers) {
      return {
        ok: false,
        text: "No CRA SOT markers found (statement of transactions / Scheme E/C/G)",
      };
    }
    const kb = Math.round(html.length / 1024);
    return { ok: true, text: `${kb} KB of HTML — looks like a CRA SOT` };
  }, [html]);

  async function doSync() {
    setStatus("syncing");
    setResult(null);
    try {
      const res = await fetch("/api/sync-nps-cra", {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: html,
      });
      const data = (await res.json().catch(() => ({}))) as IngestResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus("success");
      setResult(data);
      setHtml("");
      router.refresh();
    } catch (e) {
      setStatus("error");
      setResult({ error: (e as Error).message });
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]">
            <FileSpreadsheet size={14} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              NPS CRA Statement of Transactions
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste the full Protean CRA SOT HTML — replaces
              /credits-derived estimates with authoritative per-scheme
              units and NAVs for the FY covered
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowHelp((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            size={12}
            className={
              showHelp
                ? "rotate-90 transition-transform"
                : "transition-transform"
            }
          />
          How do I get this?
        </button>
      </div>

      {showHelp && (
        <div className="mb-4 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">
              This is optional but recommended once per FY.
            </strong>{" "}
            Everyday logging happens on /credits — this card is for
            when you want the NPS chart&apos;s per-scheme numbers to
            match CRA exactly (units, NAVs, contribution_side).
          </p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Log into your Protean CRA portal (Views → Statement of
              Transactions).
            </li>
            <li>
              Pick the FY (e.g. 2025-26) → click{" "}
              <em>View</em> to load the HTML.
            </li>
            <li>
              Right-click → <em>View Page Source</em> (or Ctrl-U).
            </li>
            <li>Ctrl-A → Ctrl-C → paste below.</li>
            <li>
              Ingest. The API wipes any /credits-derived rows for
              that FY&apos;s date range, then upserts the exact CRA
              rows on <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">(source, tx_hash)</code>
              — re-pasting the same file is a no-op.
            </li>
          </ol>
          <p className="text-[10px] text-muted-foreground/70">
            Same code path as the CLI ingester (
            <code className="font-mono">
              scripts/ingest-nps-cra-sot.ts
            </code>
            ) — parity is guaranteed.
          </p>
        </div>
      )}

      <div className="relative min-h-[200px]">
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value.slice(0, MAX_LEN))}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          className="peer absolute inset-0 h-full w-full resize-y rounded-lg border border-border bg-[hsl(240_25%_5%)] p-4 font-mono text-[11px] leading-relaxed text-transparent caret-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-transparent"
        />
        <pre
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-transparent p-4 font-mono text-[11px] leading-relaxed"
        >
          <code
            className={
              isPlaceholder ? "text-muted-foreground/40" : "text-muted-foreground"
            }
          >
            {displayed}
          </code>
        </pre>
      </div>
      <div className="mt-2 flex justify-end text-[10px] text-muted-foreground">
        {html.length.toLocaleString("en-IN")} /{" "}
        {MAX_LEN.toLocaleString("en-IN")} bytes
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <PulseDot color={status === "success" ? "success" : "warning"} />
          {parseHint ? (
            <span
              className={
                parseHint.ok
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              }
            >
              {parseHint.text}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Paste CRA SOT HTML to begin
            </span>
          )}
          {status === "success" && result?.message && (
            <span className="text-[hsl(var(--success))]">
              · {result.message}
            </span>
          )}
          {status === "error" && result?.error && (
            <span className="text-[hsl(var(--danger))]">
              · {result.error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setHtml("");
              setStatus("idle");
              setResult(null);
            }}
            disabled={status === "syncing"}
          >
            Clear
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={doSync}
            disabled={
              status === "syncing" || !html.trim() || parseHint?.ok === false
            }
          >
            {status === "syncing" && (
              <Loader2 size={12} className="animate-spin" />
            )}
            {status === "syncing" ? "Ingesting…" : "Ingest CRA SOT"}
          </Button>
        </div>
      </div>

      {status === "success" && result && <SuccessSummary result={result} />}
    </Card>
  );
}

function SuccessSummary({ result }: { result: IngestResponse }) {
  const w = result.written;
  const p = result.parsed;
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {result.fy && (
          <span className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
            FY {result.fy}
            {result.period && (
              <>
                {" "}
                · {result.period.from} → {result.period.to}
              </>
            )}
          </span>
        )}
        {w && (
          <>
            <StatChip label="Inserted" value={w.inserted} tone="success" />
            {w.auto_wiped > 0 && (
              <StatChip
                label="Auto rows replaced"
                value={w.auto_wiped}
                tone="info"
              />
            )}
            {w.skipped_existing > 0 && (
              <StatChip
                label="Unchanged"
                value={w.skipped_existing}
                tone="muted"
              />
            )}
          </>
        )}
        {p && (
          <span className="text-[10px] text-muted-foreground">
            (parsed {p.total_rows} rows · {p.contribution_count} contribs ₹
            {p.contribution_amount.toLocaleString("en-IN")} ·{" "}
            {p.billing_count} billing ₹
            {p.billing_amount.toLocaleString("en-IN")})
          </span>
        )}
      </div>

      {result.warnings && result.warnings.length > 0 && (
        <div className="rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.05)] p-2.5">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[hsl(var(--warning))]">
            Parse warnings
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "info" | "warning" | "muted";
}) {
  const toneClasses = {
    success:
      "border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]",
    info: "border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))]",
    warning:
      "border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]",
    muted: "border-border bg-muted/30 text-muted-foreground",
  }[tone];
  return (
    <div
      className={`flex items-baseline gap-1.5 rounded-md border px-2.5 py-1 ${toneClasses}`}
    >
      <span className="font-mono text-sm font-semibold tabular-nums">
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider opacity-80">
        {label}
      </span>
    </div>
  );
}
