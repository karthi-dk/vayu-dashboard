import { getCreditsData } from "@/lib/queries";
import { CreditsLog } from "@/components/credits/CreditsLog";
import { MfContributionsLog } from "@/components/credits/MfContributionsLog";
import { LedgerHeadline } from "@/components/credits/LedgerHeadline";

export const dynamic = "force-dynamic";

export default async function CreditsPage() {
  const {
    credits,
    currentMonthByType,
    mfLedger,
    currentMonthTotals,
    mfPendingCount,
  } = await getCreditsData();

  // Rendered server-side so the month string is stable regardless of
  // the client's timezone. UTC month = the one whose totals the
  // headline is summing.
  const now = new Date();
  const monthLabel = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="kicker mb-3">Savings ledger</div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Credits
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every MF transaction (Groww orders + full RTA history from
          MFCentral CAS) plus retirement corpus credits (EPF / NPS).
          All ingested from the{" "}
          <a
            href="/sync"
            className="text-[hsl(var(--primary))] hover:underline"
          >
            Sync page
          </a>
          . Each log defaults to the last 3 months of activity; use the
          month picker to reveal older entries on demand.
        </p>
      </div>

      {/* Shared strip — always at the top so the "how much this
          month" answer is visible before scrolling into either log. */}
      <LedgerHeadline
        epfInr={currentMonthTotals.epfInr}
        npsInr={currentMonthTotals.npsInr}
        mfInr={currentMonthTotals.mfInr}
        monthLabel={monthLabel}
      />

      {/* Section 1 — MF contributions come first. Trades happen
          daily / weekly, so this is where the eye lands most often;
          keeping it above the retirement log matches actual usage
          frequency. Union of Groww orders + CAS transactions. */}
      <MfContributionsLog
        entries={mfLedger}
        pendingCount={mfPendingCount}
      />

      {/* Section 2 — retirement ledger. Payroll runs monthly, so
          the EPF / NPS log updates ~1x per month; sits below the
          more active MF section. */}
      <CreditsLog
        credits={credits}
        currentMonthLogged={currentMonthByType}
      />
    </div>
  );
}
