import { notFound } from "next/navigation";
import Client from "./client";

// Fixture page for the market and guardian layouts. Only exists when built with NEXT_PUBLIC_PREVIEW=1.
export default function Page() {
  if (process.env.NEXT_PUBLIC_PREVIEW !== "1") notFound();
  return <Client />;
}
