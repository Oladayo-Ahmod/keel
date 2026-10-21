import { notFound } from "next/navigation";
import PreviewClient from "./preview-client";

// A fixture page for layout checks (mobile overflow, transfer steps) without a wallet.
// It only exists when the app is built with NEXT_PUBLIC_PREVIEW=1.
export default function Page() {
  if (process.env.NEXT_PUBLIC_PREVIEW !== "1") notFound();
  return <PreviewClient />;
}
