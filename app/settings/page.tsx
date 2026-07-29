import { EpfCard } from "@/components/settings/EpfCard";
import { NpsUnitsCard } from "@/components/settings/NpsUnitsCard";
import { NpsContribCard } from "@/components/settings/NpsContribCard";
import { getSettingsData } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // NB: getSettingsData() still returns { rotation, fundCodes, v6StartDate }
  // for the (currently retired) V6 daily rotation card. Kept in the query
  // so restoring the card is a component-only change — the Supabase read
  // is cheap and adjacent to other config the page already needs.
  const { nps, epf } = await getSettingsData();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="kicker mb-3">Manual updates</div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Configuration
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Baseline balances, monthly-contribution defaults, and manual
          drift-corrections. Log real EPF / NPS credit events on the{" "}
          <a
            href="/sync#log-credit"
            className="text-primary underline-offset-2 hover:underline"
          >
            Sync page
          </a>
          ; view the full ledger on the{" "}
          <a
            href="/credits"
            className="text-primary underline-offset-2 hover:underline"
          >
            Credits page
          </a>
          .
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <EpfCard epf={epf} />
        <NpsContribCard nps={nps} />
        <NpsUnitsCard nps={nps} />
      </div>
    </div>
  );
}
