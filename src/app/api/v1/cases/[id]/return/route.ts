import { after } from "next/server";
import { withKey, jsonBody } from "@/lib/platform/http";
import { submitReturn } from "@/lib/platform/service";
import { runAgent } from "@/lib/agent";

export const dynamic = "force-dynamic";

/** Submit the draft return (+ unsigned 8879) for the client's review. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await jsonBody(req)) as Record<string, unknown>;
  return withKey(
    req,
    async (ctx) => {
      const r = await submitReturn(ctx, { ...body, case_id: id });
      after(() => runAgent(id, "review_ready")); // Clara explains the review to the client
      return r;
    },
    { heavy: true },
  );
}
