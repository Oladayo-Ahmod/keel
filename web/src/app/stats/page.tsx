import { ContentPage } from "@/components/ContentChrome";
import { StatsView } from "@/components/stats/StatsView";
import { getStats } from "@/lib/statsServer";

export const metadata = { title: "Stats · Trozu" };
// read at request time, and cached inside getStats for about a minute, so a build never calls the RPC
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await getStats();
  return (
    <ContentPage
      title="Live stats"
      lead="Counts read from the event logs of the Trozu contracts on Mezo testnet. Nothing here is typed in by hand."
    >
      {r.ok ? <StatsView s={r.snapshot} /> : <StatsUnavailable message={r.error} />}
    </ContentPage>
  );
}

function StatsUnavailable({ message }: { message: string }) {
  return (
    <div className="glass state state-error" role="alert">
      <h3>The numbers could not be read</h3>
      <p>{message} No figures are shown rather than guessed ones. Reload in a minute.</p>
    </div>
  );
}

