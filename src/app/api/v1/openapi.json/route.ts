import { NextResponse } from "next/server";
import { openapi } from "@/lib/platform/openapi";
import { baseUrl } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json(openapi(baseUrl(req)), { headers: { "Access-Control-Allow-Origin": "*" } });
}
