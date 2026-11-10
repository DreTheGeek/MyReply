import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { getBaseUrl } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The OpenAPI document for v1. Public: it describes the API, it holds no data. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildOpenApiDocument(getBaseUrl()), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
