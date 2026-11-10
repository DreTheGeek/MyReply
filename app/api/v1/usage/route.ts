import { v1Data, v1Error, v1Route } from "@/lib/api/v1";
import { usageReport } from "@/lib/usage/meter";
import { parseUsageRange } from "@/lib/usage/range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this workspace used between two days: messages sent per platform,
 * public replies, and replies a model wrote with what they cost. Money is in
 * millionths of a dollar.
 */
export const GET = v1Route("usage:read", async (request, caller) => {
  const range = parseUsageRange(request.nextUrl.searchParams);
  if (!range.ok) return v1Error(range.error);
  return v1Data(await usageReport(caller.workspaceId, range.from, range.to));
});
