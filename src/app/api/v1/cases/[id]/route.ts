import { withKey } from "@/lib/platform/http";
import { getCaseStatus } from "@/lib/platform/service";

export const dynamic = "force-dynamic";

/** Case status: state, findings, payment, e-file and the capture guardian's current verdict. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, (ctx) => getCaseStatus(ctx, { case_id: id }));
}
