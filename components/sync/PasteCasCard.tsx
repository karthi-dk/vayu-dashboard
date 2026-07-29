"use client";

/**
 * Paste NPS CAS CSV → Preview → Apply.
 *
 * Companion of GrowwPasteCard on the /sync page. See
 * /Users/kponnu/Documents/investment-plan/dashboard/migrations/
 *   2026-07-17-cas-reconciliation.sql
 * for the underlying atomic RPC contract, and lib/nps/{camsParser,casDiff}.ts
 * for the parser + classifier that produces this UI's data.
 *
 * UX FLOW
 * -------
 *   1. User pastes CSV → status: idle → previewing → previewed.
 *   2. Preview panel renders validation, state diff, and per-event
 *      decisions (checkboxes for "new" rows, radio for near_duplicate
 *      / amount_mismatch resolutions).
 *   3. User clicks Apply → status: previewed → applying → success.
 *
 * DEFAULT DECISIONS (baked in — user only overrides if they disagree)
 *   • new              → INSERT (checkbox: checked by default)
 *   • exact_duplicate  → skip silently (no UI checkbox)
 *   • amount_mismatch  → OVERWRITE ledger with CAS amount
 *   • near_duplicate   → REPLACE_WITH_CSV (delete old row, add CAS-dated one)
 *   • voluntary        → bake into total_invested_inr (no user knob)
 *   • internal         → ignore
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PulseDot } from "@/components/ui/PulseDot";
import type { CasDiff, ClassifiedEvent, StateFieldDiff } from "@/lib/nps/casDiff";
import { fmtCompactINR, fmtDateShort, fmtINR } from "@/lib/utils";

const MAX_LEN = 200_000; // CAMS Transaction Statements can be a few dozen KB
// Placeholder is shown inside the textarea until the user pastes their
// own statement. Every identifying value is intentionally fake — the
// point is to teach the format, not leak real PRAN / name data into
// the repo (or its git history). Do NOT paste a real statement here
// when iterating on this component.
const PLACEHOLDER = `NPS Transaction Statement for Tier I Account

Subscriber Details

PRAN,'XXXXXXXXXXXX
Subscriber Name,YOUR FULL NAME
Statement Generation Date :Jan 01 2026 00:00 AM
Scheme Choice - ACTIVE CHOICE

Investment Summary
...
`;

type NearDupChoice = "replace_with_csv" | "keep_ledger" | "add_both";
type AmountMismatchChoice = "overwrite" | "keep_ledger";

type FlowState =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "previewed"; diff: CasDiff }
  | { kind: "applying"; diff: CasDiff }
  | { kind: "success"; message: string; diff: CasDiff }
  | { kind: "error"; message: string; diff?: CasDiff; hint?: string };

// ─── Component ───────────────────────────────────────────────────────────

export function PasteCasCard() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });

  // Per-event overrides. Keyed by event.key from the diff. Missing keys
  // fall back to default behavior in the API route.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [nearChoices, setNearChoices] = useState<Record<string, NearDupChoice>>({});
  const [amountChoices, setAmountChoices] = useState<Record<string, AmountMismatchChoice>>({});

  const displayCharCount = csv.length;
  const displayCharColor =
    displayCharCount > MAX_LEN * 0.9
      ? "text-[hsl(var(--danger))]"
      : "text-muted-foreground";

  const isPreviewing = flow.kind === "previewing";
  const isApplying = flow.kind === "applying";
  const busy = isPreviewing || isApplying;

  async function doPreview() {
    setFlow({ kind: "previewing" });
    try {
      const res = await fetch("/api/sync-nps/preview", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: csv,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFlow({
          kind: "error",
          message: data.error || `HTTP ${res.status}`,
          hint: data.hint,
        });
        return;
      }
      setFlow({ kind: "previewed", diff: data.diff as CasDiff });
      // Reset overrides for the new preview
      setExcluded(new Set());
      setNearChoices({});
      setAmountChoices({});
    } catch (err) {
      setFlow({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function doApply() {
    if (flow.kind !== "previewed") return;
    setFlow({ kind: "applying", diff: flow.diff });
    try {
      const res = await fetch("/api/sync-nps/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csv,
          decisions: {
            exclude: Array.from(excluded),
            nearDuplicate: nearChoices,
            amountMismatch: amountChoices,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFlow({
          kind: "error",
          message: data.error || `HTTP ${res.status}`,
          hint: data.hint,
          diff: flow.diff,
        });
        return;
      }
      setFlow({
        kind: "success",
        message: data.message || "Applied.",
        diff: (data.diff as CasDiff) ?? flow.diff,
      });
      router.refresh();
    } catch (err) {
      setFlow({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        diff: flow.diff,
      });
    }
  }

  function clearAll() {
    setCsv("");
    setFlow({ kind: "idle" });
    setExcluded(new Set());
    setNearChoices({});
    setAmountChoices({});
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <FileText size={14} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Reconcile NPS with CAMS statement
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste your CAMS-NPS Transaction Statement CSV to sync units,
              NAVs, invested total, and backfill payroll credits — one
              atomic reconciliation.
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
              showHelp ? "rotate-90 transition-transform" : "transition-transform"
            }
          />
          Where do I get this?
        </button>
      </div>

      {showHelp && (
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Log in to{" "}
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
            services.camsnps.in
          </code>{" "}
          → Statement of Transaction → pick a date range that covers this
          FY → Download as CSV → paste the entire file here (include the
          header row starting with &quot;NPS Transaction Statement&quot;).
          Data flows into <code className="font-mono text-[10px]">nps_state</code>{" "}
          and <code className="font-mono text-[10px]">retirement_credits</code>{" "}
          via one atomic RPC — safe to paste the same file twice.
        </div>
      )}

      <div className="relative min-h-[160px]">
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value.slice(0, MAX_LEN))}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          disabled={busy}
          className="peer h-[160px] w-full resize-y rounded-lg border border-border bg-[hsl(240_25%_5%)] p-4 font-mono text-[11px] leading-relaxed text-foreground/85 focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40 disabled:opacity-60"
        />
      </div>
      <div
        className={`mt-2 flex justify-end text-[10px] ${displayCharColor}`}
      >
        {/* Explicit en-IN locale on both sides so the char counter uses
            the same grouping (2,00,000) on the SSR pass and the browser
            re-hydration pass. Without the explicit locale, Node.js on
            the server picks its process-default locale (typically en-US
            in Vercel/local) while the browser uses the user's — the
            two disagree and trigger a hydration mismatch. Same
            reasoning applies anywhere else we call toLocaleString on a
            component rendered by both server and client. */}
        {displayCharCount.toLocaleString("en-IN")} /{" "}
        {MAX_LEN.toLocaleString("en-IN")}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <PulseDot color={flow.kind === "error" ? "danger" : "success"} />
          <span>
            {flow.kind === "idle" && "Ready to preview"}
            {flow.kind === "previewing" && "Parsing CSV and diffing…"}
            {flow.kind === "previewed" && "Preview ready — review below"}
            {flow.kind === "applying" && "Applying reconciliation…"}
            {flow.kind === "success" && "Done"}
            {flow.kind === "error" && "Something didn't work"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={busy}
          >
            Clear
          </Button>
          {flow.kind !== "previewed" && flow.kind !== "success" && (
            <Button
              variant="primary"
              size="sm"
              onClick={doPreview}
              disabled={busy || !csv.trim()}
            >
              {isPreviewing && <Loader2 size={12} className="animate-spin" />}
              {isPreviewing ? "Parsing…" : "Preview changes"}
            </Button>
          )}
          {flow.kind === "previewed" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={doPreview}
                disabled={busy}
              >
                Re-parse
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={doApply}
                disabled={busy || flow.diff.fatal}
              >
                {isApplying && <Loader2 size={12} className="animate-spin" />}
                {isApplying ? "Applying…" : "Apply reconciliation"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Error banner */}
      {flow.kind === "error" && (
        <div className="mt-4 rounded-md border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-[11px] text-[hsl(var(--danger))]">
          <div className="flex items-start gap-2">
            <XCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">{flow.message}</div>
              {flow.hint && (
                <div className="mt-1 text-[10px] opacity-80">{flow.hint}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Success banner */}
      {flow.kind === "success" && (
        <div className="mt-4 rounded-md border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] px-3 py-2 text-[11px] text-[hsl(var(--success))]">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <div>{flow.message}</div>
          </div>
        </div>
      )}

      {/* Preview panel */}
      {(flow.kind === "previewed" ||
        flow.kind === "applying" ||
        (flow.kind === "error" && flow.diff) ||
        flow.kind === "success") && (
        <PreviewPanel
          diff={(flow as { diff: CasDiff }).diff}
          excluded={excluded}
          setExcluded={setExcluded}
          nearChoices={nearChoices}
          setNearChoices={setNearChoices}
          amountChoices={amountChoices}
          setAmountChoices={setAmountChoices}
          readOnly={flow.kind !== "previewed"}
        />
      )}
    </Card>
  );
}

// ─── Preview panel ────────────────────────────────────────────────────────

function PreviewPanel({
  diff,
  excluded,
  setExcluded,
  nearChoices,
  setNearChoices,
  amountChoices,
  setAmountChoices,
  readOnly,
}: {
  diff: CasDiff;
  excluded: Set<string>;
  setExcluded: (s: Set<string>) => void;
  nearChoices: Record<string, NearDupChoice>;
  setNearChoices: (r: Record<string, NearDupChoice>) => void;
  amountChoices: Record<string, AmountMismatchChoice>;
  setAmountChoices: (r: Record<string, AmountMismatchChoice>) => void;
  readOnly: boolean;
}) {
  const grouped = useMemo(() => groupEvents(diff.events), [diff.events]);

  function toggleExclude(key: string) {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExcluded(next);
  }

  function setNearChoice(key: string, choice: NearDupChoice) {
    setNearChoices({ ...nearChoices, [key]: choice });
  }
  function setAmountChoice(key: string, choice: AmountMismatchChoice) {
    setAmountChoices({ ...amountChoices, [key]: choice });
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Fatal errors */}
      {diff.fatal && (
        <div className="rounded-md border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.08)] px-3 py-3 text-[11px] text-[hsl(var(--danger))]">
          <div className="mb-1.5 flex items-center gap-2 font-medium">
            <AlertCircle size={13} />
            CSV cannot be applied — fix these first:
          </div>
          <ul className="ml-4 list-disc space-y-1 text-[10px] opacity-90">
            {diff.fatalReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Subscriber banner */}
      <SubscriberBanner diff={diff} />

      {/* Validation checks — condensed strip when passing, expanded when failing */}
      <ValidationStrip diff={diff} />

      {/* State diff */}
      <StateDiffTable diff={diff} />

      {/* Events */}
      <EventsList
        grouped={grouped}
        excluded={excluded}
        toggleExclude={toggleExclude}
        nearChoices={nearChoices}
        setNearChoice={setNearChoice}
        amountChoices={amountChoices}
        setAmountChoice={setAmountChoice}
        voluntaryTotal={diff.summary.voluntaryTotalInr}
        readOnly={readOnly}
      />

      {/* Rollup */}
      <RollupSummary
        diff={diff}
        excluded={excluded}
        nearChoices={nearChoices}
        amountChoices={amountChoices}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function SubscriberBanner({ diff }: { diff: CasDiff }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          <span className="text-muted-foreground">PRAN:</span>{" "}
          <span className="font-mono text-foreground">{diff.parsed.pran}</span>
        </span>
        {diff.parsed.subscriberName && (
          <span>
            <span className="text-muted-foreground">Name:</span>{" "}
            <span className="text-foreground">{diff.parsed.subscriberName}</span>
          </span>
        )}
        <span>
          <span className="text-muted-foreground">Statement:</span>{" "}
          <span className="text-foreground">
            {fmtDateShort(diff.parsed.statementDate)}
          </span>
        </span>
        {diff.parsed.schemeChoice && (
          <span>
            <span className="text-muted-foreground">Choice:</span>{" "}
            <span className="text-foreground">{diff.parsed.schemeChoice}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ValidationStrip({ diff }: { diff: CasDiff }) {
  const v = diff.validation;
  const checks: { label: string; passed: boolean; detail?: string }[] = [
    {
      label: v.pranCurrent ? "PRAN matches" : "First-time PRAN seed",
      passed: v.pranMatches,
      detail: v.pranCurrent
        ? undefined
        : `Will store ${v.pranFromCsv} on nps_state`,
    },
    {
      label: "POP variant",
      passed: v.variantIsPop,
      detail: v.variantIsPop ? undefined : `Found: ${v.variantsFound.join(", ")}`,
    },
    { label: "Tier I", passed: v.tierIsOne },
    {
      label: "Sum sanity",
      passed: v.sumChecksPass,
      detail: v.sumChecksPass
        ? `${fmtINR(v.sumComputed)} ≈ ${fmtINR(v.sumDeclared)}`
        : `Σ = ${fmtINR(v.sumComputed)} vs declared ${fmtINR(v.sumDeclared)}`,
    },
    {
      label: "Not regressing",
      passed: v.navDateNotRegressing,
      detail: v.dbNavDate
        ? `DB: ${v.dbNavDate} · CAS: ${v.navDate}`
        : `First reconciliation`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {checks.map((c) => (
        <div
          key={c.label}
          className={`rounded-md border px-2.5 py-1.5 text-[10px] ${
            c.passed
              ? "border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)]"
              : "border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.08)]"
          }`}
        >
          <div className="flex items-center gap-1">
            {c.passed ? (
              <ShieldCheck
                size={10}
                className="text-[hsl(var(--success))]"
              />
            ) : (
              <AlertCircle
                size={10}
                className="text-[hsl(var(--danger))]"
              />
            )}
            <span
              className={
                c.passed
                  ? "font-medium text-[hsl(var(--success))]"
                  : "font-medium text-[hsl(var(--danger))]"
              }
            >
              {c.label}
            </span>
          </div>
          {c.detail && (
            <div className="mt-0.5 text-muted-foreground">{c.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── State diff table ─────────────────────────────────────────────────────

function StateDiffTable({ diff }: { diff: CasDiff }) {
  const s = diff.stateDiff;
  const rows: {
    label: string;
    field: StateFieldDiff<number> | StateFieldDiff<string | null>;
    format: (v: number | string | null) => string;
  }[] = [
    {
      label: "Scheme E units",
      field: s.scheme_e_units,
      format: (v) => (typeof v === "number" ? v.toFixed(4) : "—"),
    },
    {
      label: "Scheme C units",
      field: s.scheme_c_units,
      format: (v) => (typeof v === "number" ? v.toFixed(4) : "—"),
    },
    {
      label: "Scheme G units",
      field: s.scheme_g_units,
      format: (v) => (typeof v === "number" ? v.toFixed(4) : "—"),
    },
    {
      label: "Scheme E NAV",
      field: s.scheme_e_nav,
      format: (v) => (typeof v === "number" ? `₹${v.toFixed(4)}` : "—"),
    },
    {
      label: "Scheme C NAV",
      field: s.scheme_c_nav,
      format: (v) => (typeof v === "number" ? `₹${v.toFixed(4)}` : "—"),
    },
    {
      label: "Scheme G NAV",
      field: s.scheme_g_nav,
      format: (v) => (typeof v === "number" ? `₹${v.toFixed(4)}` : "—"),
    },
    {
      label: "Total invested",
      field: s.total_invested_inr,
      format: (v) => (typeof v === "number" ? fmtINR(v) : "—"),
    },
    {
      label: "NAV date",
      field: s.nav_date,
      format: (v) => (typeof v === "string" ? fmtDateShort(v) : "—"),
    },
  ];

  return (
    <div className="rounded-md border border-border bg-muted/10">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        nps_state changes {s.anyChanged ? "" : "(none — state already matches)"}
      </div>
      <div className="divide-y divide-border/60 text-[11px]">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-3 items-center gap-2 px-3 py-1.5"
          >
            <span className="text-muted-foreground">{r.label}</span>
            <span className="font-mono text-foreground/70">
              {r.format(r.field.current)}
            </span>
            <span
              className={
                r.field.changed
                  ? "font-mono font-semibold text-[hsl(var(--primary))]"
                  : "font-mono text-foreground/50"
              }
            >
              {r.format(r.field.proposed)}
              {r.field.changed && (
                <span className="ml-1 text-[9px] uppercase tracking-wide">
                  {" "}
                  · new
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Events list ──────────────────────────────────────────────────────────

type GroupedEvents = Record<ClassifiedEvent["status"], ClassifiedEvent[]>;

function groupEvents(events: ClassifiedEvent[]): GroupedEvents {
  const g: GroupedEvents = {
    new: [],
    exact_duplicate: [],
    amount_mismatch: [],
    near_duplicate: [],
    skipped_voluntary: [],
    skipped_internal: [],
  };
  for (const e of events) g[e.status].push(e);
  return g;
}

const STATUS_META: Record<
  ClassifiedEvent["status"],
  { label: string; tone: "primary" | "muted" | "warning" | "success" }
> = {
  new: { label: "Will add", tone: "primary" },
  exact_duplicate: { label: "Already in ledger", tone: "success" },
  amount_mismatch: { label: "Amount mismatch", tone: "warning" },
  near_duplicate: { label: "Near-duplicate (different date)", tone: "warning" },
  skipped_voluntary: { label: "Voluntary — baked into invested", tone: "muted" },
  skipped_internal: { label: "Internal (skipped)", tone: "muted" },
};

function EventsList({
  grouped,
  excluded,
  toggleExclude,
  nearChoices,
  setNearChoice,
  amountChoices,
  setAmountChoice,
  voluntaryTotal,
  readOnly,
}: {
  grouped: GroupedEvents;
  excluded: Set<string>;
  toggleExclude: (key: string) => void;
  nearChoices: Record<string, NearDupChoice>;
  setNearChoice: (key: string, choice: NearDupChoice) => void;
  amountChoices: Record<string, AmountMismatchChoice>;
  setAmountChoice: (key: string, choice: AmountMismatchChoice) => void;
  voluntaryTotal: number;
  readOnly: boolean;
}) {
  const orderedStatuses: ClassifiedEvent["status"][] = [
    "new",
    "amount_mismatch",
    "near_duplicate",
    "exact_duplicate",
    "skipped_voluntary",
    "skipped_internal",
  ];

  return (
    <div className="rounded-md border border-border bg-muted/10">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Ledger reconciliation
      </div>
      <div className="divide-y divide-border/60">
        {orderedStatuses.map((status) => {
          const events = grouped[status];
          if (events.length === 0) return null;
          const meta = STATUS_META[status];
          const isVoluntaryGroup = status === "skipped_voluntary";
          return (
            <div key={status} className="px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide ${
                    meta.tone === "primary"
                      ? "text-[hsl(var(--primary))]"
                      : meta.tone === "warning"
                        ? "text-[hsl(var(--warning))]"
                        : meta.tone === "success"
                          ? "text-[hsl(var(--success))]"
                          : "text-muted-foreground"
                  }`}
                >
                  {meta.label} ({events.length})
                </span>
                {isVoluntaryGroup && (
                  <span className="text-[10px] text-muted-foreground">
                    Total baked-in: {fmtINR(voluntaryTotal)}
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                {events.map((ev) => (
                  <EventRow
                    key={ev.key}
                    ev={ev}
                    isExcluded={excluded.has(ev.key)}
                    onToggleExclude={() => toggleExclude(ev.key)}
                    nearChoice={nearChoices[ev.key]}
                    onSetNearChoice={(c) => setNearChoice(ev.key, c)}
                    amountChoice={amountChoices[ev.key]}
                    onSetAmountChoice={(c) => setAmountChoice(ev.key, c)}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventRow({
  ev,
  isExcluded,
  onToggleExclude,
  nearChoice,
  onSetNearChoice,
  amountChoice,
  onSetAmountChoice,
  readOnly,
}: {
  ev: ClassifiedEvent;
  isExcluded: boolean;
  onToggleExclude: () => void;
  nearChoice: NearDupChoice | undefined;
  onSetNearChoice: (c: NearDupChoice) => void;
  amountChoice: AmountMismatchChoice | undefined;
  onSetAmountChoice: (c: AmountMismatchChoice) => void;
  readOnly: boolean;
}) {
  const includable =
    ev.status === "new" ||
    ev.status === "amount_mismatch" ||
    ev.status === "near_duplicate";

  return (
    <div
      className={`rounded border border-border/60 px-2.5 py-1.5 text-[11px] ${
        isExcluded ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {includable && (
            <input
              type="checkbox"
              checked={!isExcluded}
              onChange={onToggleExclude}
              disabled={readOnly}
              className="mt-1 h-3 w-3 accent-[hsl(var(--primary))]"
              title={isExcluded ? "Include this row" : "Skip this row"}
            />
          )}
          <div>
            <div className="flex flex-wrap items-center gap-x-2 text-foreground">
              <span className="font-mono">{fmtDateShort(ev.csv.dateIso)}</span>
              <span className="font-mono">
                {fmtCompactINR(ev.csv.amountInr)}
              </span>
              <span className="text-muted-foreground">
                {shortParticulars(ev.csv.particulars)}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {ev.reason}
            </div>
            {ev.status === "near_duplicate" && ev.ledgerMatch && (
              <div className="mt-1.5 rounded bg-muted/40 px-2 py-1 text-[10px]">
                <div className="text-muted-foreground">
                  Ledger row: id {ev.ledgerMatch.id} ·{" "}
                  {fmtDateShort(ev.ledgerMatch.credit_date)} ·{" "}
                  {fmtCompactINR(ev.ledgerMatch.amount_inr)} ({ev.daysApart}d
                  off)
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`near-${ev.key}`}
                      value="replace_with_csv"
                      checked={(nearChoice ?? "replace_with_csv") === "replace_with_csv"}
                      onChange={() => onSetNearChoice("replace_with_csv")}
                      disabled={readOnly}
                      className="h-3 w-3 accent-[hsl(var(--primary))]"
                    />
                    Replace ledger with CAS date (recommended)
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`near-${ev.key}`}
                      value="keep_ledger"
                      checked={nearChoice === "keep_ledger"}
                      onChange={() => onSetNearChoice("keep_ledger")}
                      disabled={readOnly}
                      className="h-3 w-3 accent-[hsl(var(--primary))]"
                    />
                    Keep ledger as-is
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`near-${ev.key}`}
                      value="add_both"
                      checked={nearChoice === "add_both"}
                      onChange={() => onSetNearChoice("add_both")}
                      disabled={readOnly}
                      className="h-3 w-3 accent-[hsl(var(--primary))]"
                    />
                    Add both
                  </label>
                </div>
              </div>
            )}
            {ev.status === "amount_mismatch" && ev.ledgerMatch && (
              <div className="mt-1.5 rounded bg-muted/40 px-2 py-1 text-[10px]">
                <div className="text-muted-foreground">
                  Ledger row: id {ev.ledgerMatch.id} ·{" "}
                  {fmtDateShort(ev.ledgerMatch.credit_date)} · currently{" "}
                  {fmtCompactINR(ev.ledgerMatch.amount_inr)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[10px]">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`amt-${ev.key}`}
                      value="overwrite"
                      checked={(amountChoice ?? "overwrite") === "overwrite"}
                      onChange={() => onSetAmountChoice("overwrite")}
                      disabled={readOnly}
                      className="h-3 w-3 accent-[hsl(var(--primary))]"
                    />
                    Overwrite with CAS amount (recommended)
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`amt-${ev.key}`}
                      value="keep_ledger"
                      checked={amountChoice === "keep_ledger"}
                      onChange={() => onSetAmountChoice("keep_ledger")}
                      disabled={readOnly}
                      className="h-3 w-3 accent-[hsl(var(--primary))]"
                    />
                    Keep ledger amount
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "By Arrear - Regular contribution of March" → "March payroll"
 * "By Voluntary Contributions" → "Voluntary"
 * anything else → return trimmed
 */
function shortParticulars(p: string): string {
  const monthMatch = p.match(/regular\s+contribution\s+of\s+([A-Za-z]+)/i);
  if (monthMatch) return `${monthMatch[1]} payroll`;
  if (/^by\s+voluntary/i.test(p)) return "Voluntary";
  return p.length > 60 ? `${p.slice(0, 60)}…` : p;
}

// ─── Rollup summary ──────────────────────────────────────────────────────

function RollupSummary({
  diff,
  excluded,
  nearChoices,
  amountChoices,
}: {
  diff: CasDiff;
  excluded: Set<string>;
  nearChoices: Record<string, NearDupChoice>;
  amountChoices: Record<string, AmountMismatchChoice>;
}) {
  // Recompute counts based on current choices — this is what will
  // actually happen if the user hits Apply. Keeps the UI feedback loop
  // tight and gives the user an accurate final tally.
  const applying = diff.events.filter((e) => {
    if (excluded.has(e.key)) return false;
    if (e.status === "new") return true;
    if (e.status === "amount_mismatch") {
      return (amountChoices[e.key] ?? "overwrite") === "overwrite";
    }
    if (e.status === "near_duplicate") {
      const c = nearChoices[e.key] ?? "replace_with_csv";
      return c === "replace_with_csv" || c === "add_both";
    }
    return false;
  }).length;

  const skipping = diff.events.filter((e) => {
    if (excluded.has(e.key)) return true;
    if (e.status === "exact_duplicate") return true;
    if (e.status === "skipped_voluntary" || e.status === "skipped_internal")
      return true;
    if (e.status === "amount_mismatch") {
      return (amountChoices[e.key] ?? "overwrite") === "keep_ledger";
    }
    if (e.status === "near_duplicate") {
      return (nearChoices[e.key] ?? "replace_with_csv") === "keep_ledger";
    }
    return false;
  }).length;

  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="text-foreground">
        {applying} event{applying === 1 ? "" : "s"} will be written
      </span>
      {" · "}
      {skipping} skipped
      {" · "}
      state diff {diff.stateDiff.anyChanged ? "applies" : "is a no-op"}
    </div>
  );
}
