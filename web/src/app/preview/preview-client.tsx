"use client";

import dynamic from "next/dynamic";

const Inner = dynamic(() => import("./preview-inner"), { ssr: false });

export default function PreviewClient() {
  return <Inner />;
}
