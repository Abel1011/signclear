"use client";
import { use } from "react";
import { PreparerPanel } from "@/components/PreparerPanel";

export default function PreparerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <PreparerPanel tokens={[token]} />;
}
