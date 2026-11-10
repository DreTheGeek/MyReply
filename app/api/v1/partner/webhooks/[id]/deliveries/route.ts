import { partnerRoute } from "@/lib/api/v1";
import { listDeliveriesResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The endpoint's delivery log, across all of the partner's workspaces. */
export const GET = partnerRoute<{ id: string }>("webhooks:read", (request, partner, params) =>
  listDeliveriesResponse(request, { partnerId: partner.partnerId }, params.id)
);
