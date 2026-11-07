import raw from "@/content/proof.json";
import { renderCard } from "@/lib/cardImage";
import { parseProof } from "@/lib/content";
import { proofCard } from "@/lib/share";

// built from the proof file alone: no chain reads, no private values
export const dynamic = "force-static";

export function GET() {
  return renderCard(proofCard(parseProof(raw)), "public, s-maxage=300, stale-while-revalidate=600");
}
