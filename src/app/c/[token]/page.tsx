"use client";
import { use } from "react";
import { ClientApp } from "@/components/ClientApp";

export default function ClientPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ClientApp token={token} />;
}
