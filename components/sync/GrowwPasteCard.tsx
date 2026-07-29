"use client";

import { useRouter } from "next/navigation";
import { type ReactElement, useMemo, useState } from "react";
import { ChevronRight, Code2, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";
import { TimeAgo } from "@/components/ui/TimeAgo";

// Groww's /dashboard payload has grown materially — each scheme now carries
// a verbose schemeConfig block (LUMPSUM/SWITCH/STP_V2/REDEMPTION/… action
// descriptors), and multi-folio schemes emit a `folios[]` array with a
// folioConfig per row. Portfolios with a handful of forked folios blow past
// the old 64 KB cap. 1 MB gives comfortable headroom for further Groww
// bloat without needing to revisit this file every few months.
const MAX_LEN = 1_048_576;

const PLACEHOLDER = `{
  "holdings": [
    { "scheme_code": "PPFAS_FC", "units": 1247.32, "nav": 514.82 },
    ...
  ]
}`;

function highlightJson(src: string): (string | ReactElement)[] {
  const out: (string | ReactElement)[] = [];
  const rx = /("([^"\\]|\\.)*")|(-?\d+(\.\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = rx.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('"')) {
      const rest = src.slice(rx.lastIndex).replace(/^\s*/, "");
      const isKey = rest.startsWith(":");
      out.push(
        <span
          key={`t-${key++}`}
          className={isKey ? "text-[hsl(220_80%_75%)]" : "text-[hsl(30_90%_70%)]"}
        >
          {token}
        </span>
      );
    } else {
      out.push(
        <span key={`t-${key++}`} className="text-[hsl(150_65%_65%)]">
          {token}
        </span>
      );
    }
    last = rx.lastIndex;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function GrowwPasteCard({ lastSync }: { lastSync: string | null }) {
  const router = useRouter();
  const [json, setJson] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState<"idle" | "syncing" | "success" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);
  // Local override so the "Last synced" label updates immediately on success
  // instead of waiting for router.refresh() to round-trip. Server render will
  // eventually replace this with the actual DB timestamp, but this makes the
  // UI feel instant.
  const [justSyncedAt, setJustSyncedAt] = useState<string | null>(null);
  const displayLastSync = justSyncedAt ?? lastSync;

  const displayed = json || PLACEHOLDER;
  const isPlaceholder = !json;

  const parseHint = useMemo(() => {
    if (!json.trim()) return null;
    try {
      const parsed = JSON.parse(json);
      const n =
        Array.isArray(parsed?.holdings) ? parsed.holdings.length : null;
      if (n == null) return { ok: false, text: "Missing top-level `holdings` array" };
      return { ok: true, text: `${n} funds detected` };
    } catch (e) {
      // Distinguish truncation from actual syntax errors — the two failure
      // modes need different fixes (paste more vs. fix your JSON) and the
      // old "check for trailing commas" message misled users who had simply
      // hit the character cap. V8's `JSON.parse` reports truncation via
      // several shapes depending on WHERE the cut happens:
      //   • cut mid-value      → "Unexpected end of JSON input"
      //   • cut right after `,`→ "Expected double-quoted property name in
      //                            JSON at position N" (N == end of input)
      //   • cut inside string  → "Unterminated string in JSON at position N"
      // Instead of enumerating all of V8's phrasings, we extract the
      // reported position (if any) and compare against string length —
      // an error occurring at (or within one char of) EOF is almost
      // always truncation, not a real syntax bug.
      const msg = (e as Error).message ?? "";
      const posMatch = /position\s+(\d+)/i.exec(msg);
      const errPos = posMatch ? Number(posMatch[1]) : -1;
      const trimmed = json.trimEnd();
      const endsCleanly = /[}\]]$/.test(trimmed);
      const errAtEof = errPos >= 0 && errPos >= trimmed.length - 1;
      const looksTruncated =
        json.length >= MAX_LEN ||
        /unexpected end of json/i.test(msg) ||
        (errAtEof && !endsCleanly);
      if (looksTruncated) {
        return {
          ok: false,
          text:
            json.length >= MAX_LEN
              ? `Paste truncated at ${MAX_LEN.toLocaleString("en-IN")} chars — re-copy the full response`
              : "Input appears truncated — clear and re-paste the full response",
        };
      }
      return { ok: false, text: `Invalid JSON — ${msg.replace(/^JSON\.parse:\s*/, "")}` };
    }
  }, [json]);

  async function doSync() {
    setStatus("syncing");
    setMessage(null);
    try {
      const res = await fetch("/api/sync-groww", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus("success");
      setMessage(data.message || "Synced successfully.");
      setJson("");
      // Optimistically show "just now" immediately, then trigger a server
      // re-render so all downstream reads (NW headline, portfolio charts,
      // sector exposure) reflect the fresh values without a manual reload.
      setJustSyncedAt(new Date().toISOString());
      router.refresh();
    } catch (e) {
      setStatus("error");
      setMessage((e as Error).message);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]">
            <Code2 size={14} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Sync Groww portfolio
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste the JSON payload from Groww to refresh MF values
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
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Open Groww Web · Portfolio · in DevTools Network tab, find the
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
            /v1/api/aggregator/v4/dashboard
          </code>
          call · Copy Response · paste below. Only the{" "}
          <code className="font-mono text-[10px] text-foreground">
            holdings
          </code>{" "}
          array is read; other fields are ignored.
        </div>
      )}

      <div className="relative min-h-[180px]">
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value.slice(0, MAX_LEN))}
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
            {isPlaceholder ? PLACEHOLDER : highlightJson(displayed)}
          </code>
        </pre>
      </div>
      <div className="mt-2 flex justify-end text-[10px] text-muted-foreground">
        {/* Explicit en-IN locale — see PasteCasCard.tsx for the
            hydration-mismatch rationale (server default locale vs
            browser locale produces "2,00,000" vs "200,000"). */}
        {json.length.toLocaleString("en-IN")} /{" "}
        {MAX_LEN.toLocaleString("en-IN")}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <PulseDot color={displayLastSync ? "success" : "warning"} />
          <span className="text-muted-foreground">
            Last synced <TimeAgo isoDate={displayLastSync} />
          </span>
          {parseHint && (
            <span
              className={
                parseHint.ok
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              }
            >
              · {parseHint.text}
            </span>
          )}
          {status === "success" && message && (
            <span className="text-[hsl(var(--success))]">· {message}</span>
          )}
          {status === "error" && message && (
            <span className="text-[hsl(var(--danger))]">· {message}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setJson("");
              setStatus("idle");
              setMessage(null);
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
              status === "syncing" || !json.trim() || parseHint?.ok === false
            }
          >
            {status === "syncing" && <Loader2 size={12} className="animate-spin" />}
            {status === "syncing" ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
