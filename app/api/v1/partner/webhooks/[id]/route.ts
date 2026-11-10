import { partnerRoute } from "@/lib/api/v1";
import { deleteEndpointResponse, updateEndpointResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = partnerRoute<{ id: string }>("webhooks:write", (request, partner, params) =>
  updateEndpointResponse(request, { partnerId: partner.partnerId }, params.id)
);

export const DELETE = partnerRoute<{ id: string }>("webhooks:write", (_request, partner, params) =>
  deleteEndpointResponse({ partnerId: partner.partnerId }, params.id)
);
