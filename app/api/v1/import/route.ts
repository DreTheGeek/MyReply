import { NextRequest } from "next/server";
import { POST as importCampaigns } from "@/app/api/automations/import/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Batch-create campaigns, up to 200 in one call. This is the endpoint another
 * product provisions a client through.
 */
export async function POST(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return importCampaigns(request);
}
