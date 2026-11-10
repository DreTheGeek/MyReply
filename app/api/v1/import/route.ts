import { POST as importCampaigns } from "@/app/api/automations/import/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Batch-create campaigns, up to 200 in one call. This is the endpoint another
 * product provisions a client through.
 */
export const POST = v1Route("campaigns:write", (request) => importCampaigns(request));
