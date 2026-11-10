import { partnerRoute } from "@/lib/api/v1";
import { createEndpointResponse, listEndpointsResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The partner's own endpoints, which hear every one of its workspaces. */
export const GET = partnerRoute("webhooks:read", (_request, partner) =>
  listEndpointsResponse({ partnerId: partner.partnerId })
);

/** Add an endpoint. The answer carries its signing secret, shown this once. */
export const POST = partnerRoute("webhooks:write", (request, partner) =>
  createEndpointResponse(request, { partnerId: partner.partnerId })
);
