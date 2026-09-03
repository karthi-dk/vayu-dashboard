"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Globe, Loader2, Upload } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const MAX_LEN = 4_000_000; // ~4 MB — the iShares payload is ~450 KB

// The exact iShares URLs to fetch HDFC DM's MSCI World look-through. The
// endpoint is Akamai-gated, so it must be opened in a browser session (open
// the product page first) — not called server-side. Bump asOfDate monthly.
const PRODUCT_URL = "https://www.ishares.com/uk/individual/en/products/251882";
const API_URL =
  "https://www.ishares.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data?appSubType=ISHARES&appType=PRODUCT_PAGE&component=holdings.all&locale=en_GB&portfolioId=251882&targetSite=ishares-uk&userType=individual&excludeContent=true&asOfDate=20260831&includeConfig=true";

type IngestOk = {
  ok: true;
  fundName: string;
  asOf: string;
  equityHoldings: number;
  coveragePct: number;
  existingMatched: number;
  newMasterRows: number;
  skippedNonEquity: number;
};

/**
 * Paste the iShares MSCI World holdings JSON to refresh HDFC GIFT City's
 * look-through — the "resync" this foreign fund can't get from Dhan. The
 * fetch stays manual (the iShares endpoint is Akamai-gated, so it can only
 * be called from your browser/terminal with live cookies); this card just
 * ingests the JSON you paste.
 */
export function IntlHoldingsPasteCard() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string | null>(null);

  async function ingest() {
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/ingest-intl-holdings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const b = body as IngestOk;
      setState("success");
      setMessage(
        `${b.fundName} · ${b.equityHoldings} holdings (${b.coveragePct}% weight) · ` +
          `${b.newMasterRows} new names classified, ${b.existingMatched} reused · ` +
          `${b.skippedNonEquity} cash/derivatives skipped · as of ${b.asOf}.`
      );
      setText("");
      router.refresh();
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  const isLoading = state === "loading";
  const tooBig = text.length > MAX_LEN;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Globe size={16} />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                International holdings — paste look-through
              </h3>
              <p className="mt-0.5 kicker">
                HDFC GIFT City · MSCI World UCITS constituents from iShares
              </p>
            </div>
            <Button
              onClick={ingest}
              disabled={isLoading || text.trim().length === 0 || tooBig}
              className="inline-flex items-center gap-1.5"
            >
              {isLoading ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Ingesting…
                </>
              ) : (
                <>
                  <Upload size={13} />
                  Ingest holdings
                </>
              )}
            </Button>
          </div>

          <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              The iShares endpoint is bot-gated, so the fetch stays in your
              browser — two steps:
            </p>
            <ol className="ml-4 list-decimal space-y-1.5">
              <li>
                Open the ETF page (sets the session cookies):{" "}
                <a
                  href={PRODUCT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-mono text-[hsl(var(--primary))] underline"
                >
                  {PRODUCT_URL}
                </a>
              </li>
              <li>
                Then open this in the same tab and copy the JSON it returns:
                <a
                  href={API_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all rounded bg-muted/40 p-2 font-mono text-[10px] text-[hsl(var(--primary))] underline"
                >
                  {API_URL}
                </a>
              </li>
            </ol>
            <p className="text-[10px]">
              Bump <span className="font-mono">asOfDate</span> to the latest
              month-end. New constituents are auto-classified; cash /
              derivatives are ignored.
            </p>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isLoading}
            spellCheck={false}
            placeholder='{"fundName":"iShares Core MSCI World UCITS ETF","componentsByNameMap":{"holdings":{ … }}}'
            className="mt-2 h-32 w-full resize-y rounded-md border border-border bg-muted/20 p-3 font-mono text-[11px] text-foreground outline-none focus:border-[hsl(var(--primary)/0.5)]"
          />

          {tooBig && (
            <p className="mt-1 text-[11px] text-[hsl(var(--danger))]">
              Paste is over 4 MB — that doesn&apos;t look like the holdings
              payload.
            </p>
          )}

          {message && (
            <div
              className={
                state === "error"
                  ? "mt-3 rounded-md border border-[hsl(var(--danger)/0.3)] bg-[hsl(var(--danger)/0.1)] px-3 py-2 text-[11px] text-[hsl(var(--danger))]"
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
