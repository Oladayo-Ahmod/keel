import { positionLensAbi } from "@/abi/keel";
import { config } from "@/config";
import { wave2 } from "@/config/wave2";
import { renderCard } from "@/lib/cardImage";
import { freshRead } from "@/lib/rpc";
import { missingCard, parseTokenId, parseWave, positionCard, unavailableCard, type CardSource } from "@/lib/share";

// the numbers move with the chain, so the image is made per request and shared caches keep it for a minute
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FRESH = "public, s-maxage=60, stale-while-revalidate=120";
const SHORT = "public, s-maxage=15";
// ERC721NonexistentToken(uint256), by name or by selector
const NONEXISTENT = /ERC721NonexistentToken|0x7e273289/;

export async function GET(_req: Request, { params }: { params: { wave: string; id: string } }) {
  const wave = parseWave(params.wave);
  const id = parseTokenId(params.id);
  if (!wave || id === undefined) return new Response("Not a position link", { status: 404 });
  const lens = wave === "2" ? wave2.lens : config.keel.lens;
  try {
    const r = await freshRead((c) => c.readContract({ address: lens, abi: positionLensAbi, functionName: "positionInfo", args: [id] }));
    return renderCard(positionCard(r.data as unknown as CardSource, wave, r.freshness.stale), r.freshness.stale ? SHORT : FRESH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (NONEXISTENT.test(msg)) return renderCard(missingCard(id), SHORT, 404);
    return renderCard(unavailableCard(id), SHORT);
  }
}
