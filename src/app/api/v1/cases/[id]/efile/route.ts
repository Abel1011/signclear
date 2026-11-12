import { withKey, jsonBody } from "@/lib/platform/http";
import { recordEfileSubmission } from "@/lib/platform/service";

export const dynamic = "force-dynamic";

/** Register the IRS e-file transmission (Submission ID). Only after the client approved (AUTHORIZED). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await jsonBody(req)) as Record<string, unknown>;
  return withKey(req, (ctx) => recordEfileSubmission(ctx, { ...body, case_id: id }));
}
