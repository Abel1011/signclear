import { withKey } from "@/lib/platform/http";
import { requestFeeCapture } from "@/lib/platform/service";

export const dynamic = "force-dynamic";

/** Ask the money guardian to capture the fee. Returns the refused conditions verbatim when it says no. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withKey(req, (ctx) => requestFeeCapture(ctx, { case_id: id }));
}
