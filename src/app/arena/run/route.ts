// "Run live": runs both sides of one Arena scenario now and streams the trace as NDJSON.
import { runBatch } from "@/lib/arena/runner";
import { SCENARIOS, type ScenarioId } from "@/lib/arena/scenarios";
import { rateLimited, clientIp } from "@/lib/platform/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { scenario?: string };
  const scenario = String(b.scenario ?? "") as ScenarioId;
  if (!(scenario in SCENARIOS)) return Response.json({ error: "unknown scenario" }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "Live runs are not configured on this server." }, { status: 503 });
  // Each run costs two short agent loops: keep it small.
  const ip = rateLimited(`arena:${clientIp(req)}`, 3, 10 * 60_000);
  const all = rateLimited("arena:global", 20, 60 * 60_000);
  if (ip.limited || all.limited)
    return Response.json({ error: `Live runs are rate-limited; try again in ${Math.ceil(Math.max(ip.retryAfterSec, all.retryAfterSec) / 60)} min. The recorded runs are shown meanwhile.` }, { status: 429 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (x: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(x) + "\n"));
      try {
        const r = await runBatch(scenario, (side, step) => send({ type: "step", side, step }));
        for (const side of ["naive", "signclear"] as const) {
          const x = r[side];
          send({ type: "done", side, run: { id: x.id, scenario, side, batch: r.batch, model: process.env.AGENT_MODEL ?? "claude-sonnet-5-5", trace: x.trace, outcome: x.outcome, createdAt: x.createdAt } });
        }
      } catch (e) {
        send({ type: "error", message: String((e as Error).message ?? e).slice(0, 200) });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
