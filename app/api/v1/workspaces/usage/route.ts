import { partnerRoute, v1Data, v1Error } from "@/lib/api/v1";
import { partnerUsageReport } from "@/lib/usage/meter";
import { parseUsageRange } from "@/lib/usage/range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Usage for every one of the partner's workspaces in one call, which is what
 * a monthly bill to the partner's own users is drawn up from.
 */
export const GET = partnerRoute("workspaces:read", async (request, partner) => {
  const range = parseUsageRange(request.nextUrl.searchParams);
  if (!range.ok) return v1Error(range.error);
  return v1Data(await partnerUsageReport(partner.partnerId, range.from, range.to));
});
