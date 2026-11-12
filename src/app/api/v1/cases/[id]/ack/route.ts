import { withKey, jsonBody } from "@/lib/platform/http";
import { uploadIrsAcknowledgment } from "@/lib/platform/service";

export const dynamic = "force-dynamic";

/** Upload the IRS e-file acknowledgment DOCUMENT. SignClear reads it and verifies it by code; only a proven
 *  acceptance of this case's Submission ID lets the capture guardian (R13) release the fee. Counts as a heavy call. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await jsonBody(req)) as Record<string, unknown>;
  return withKey(req, (ctx) => uploadIrsAcknowledgment(ctx, { ...body, case_id: id }), { heavy: true });
}
