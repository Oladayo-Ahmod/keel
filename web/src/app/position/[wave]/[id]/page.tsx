import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentPage } from "@/components/ContentChrome";
import { PositionView } from "@/components/PositionView";
import { parseTokenId, parseWave } from "@/lib/share";

type Params = { params: { wave: string; id: string } };

export function generateMetadata({ params }: Params): Metadata {
  const wave = parseWave(params.wave);
  const id = parseTokenId(params.id);
  if (!wave || id === undefined) return { title: "Position · Trozu" };
  const title = `Position #${id} · Trozu`;
  const description = "A Trozu position on Mezo testnet. The preview shows public on-chain values only.";
  const image = { url: `/og/position/${wave}/${id}`, width: 1200, height: 630, alt: `Trozu position #${id}` };
  return { title, description, openGraph: { title, description, images: [image] }, twitter: { card: "summary_large_image", title, description, images: [image.url] } };
}

export default function Page({ params }: Params) {
  const wave = parseWave(params.wave);
  const id = parseTokenId(params.id);
  if (!wave || id === undefined) notFound();
  return (
    <ContentPage title={`Position #${id}`} lead="Read from the chain. Anyone can open this link; managing the position needs the wallet that holds it.">
      <PositionView id={id} wave={wave} />
    </ContentPage>
  );
}
