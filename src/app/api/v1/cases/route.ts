import { withKey, jsonBody } from "@/lib/platform/http";
import { createClientCase, listCases } from "@/lib/platform/service";

export const dynamic = "force-dynamic";

/** List this key's cases. */
export async function GET(req: Request) {
  return withKey(req, (ctx) => listCases(ctx));
}

/** Create a client case; returns the private client link. Send `Idempotency-Key` to make retries safe. */
export async function POST(req: Request) {
  const body = await jsonBody(req);
  const idempotencyKey = req.headers.get("idempotency-key");
  return withKey(req, (ctx) => createClientCase(ctx, body, { idempotencyKey }), { status: 201 });
}
