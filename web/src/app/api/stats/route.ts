import { getStats } from "@/lib/statsServer";

// getStats keeps its numbers for about a minute, so shared caches may hold the response for the same time.
// A read that stopped early is held for a few seconds only, so the next request continues it.
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await getStats();
  if (!r.ok) {
    return Response.json({ ok: false, error: r.error }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const age = r.snapshot.range.complete && !r.snapshot.degraded ? 60 : 5;
  return Response.json({ ok: true, ...r.snapshot }, { headers: { "Cache-Control": `public, s-maxage=${age}, stale-while-revalidate=${age * 2}` } });
}
