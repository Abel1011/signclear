import type { Metadata } from "next";
import { latestRuns } from "@/lib/arena/runner";
import type { ArenaRunView } from "@/lib/arena/scenarios";
import { APP_NAME } from "@/lib/brand";
import { ArenaClient } from "./ArenaClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Agent Arena — ${APP_NAME}`,
  description: "The same AI preparer agent, with and without SignClear: honest, compromised and impatient.",
};

export default async function ArenaPage() {
  const runs = (await latestRuns().catch(() => ({}))) as Record<string, ArenaRunView>;
  return <ArenaClient initial={runs} />;
}
