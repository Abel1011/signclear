import type { Metadata } from "next";
import { headers } from "next/headers";
import { ConnectClient } from "./ConnectClient";
import { APP_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Connect your AI preparer — ${APP_NAME}`,
  description: "API keys, MCP server and REST API for human and AI tax preparers.",
};

export const dynamic = "force-dynamic";

/** The snippets show this server's real origin from the first render (no placeholder host). */
export default async function ConnectPage() {
  const env = process.env.APP_BASE_URL ?? process.env.PUBLIC_BASE_URL;
  let origin = env?.replace(/\/$/, "") ?? "";
  if (!origin) {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    origin = `${proto}://${host}`;
  }
  return <ConnectClient initialOrigin={origin} />;
}
