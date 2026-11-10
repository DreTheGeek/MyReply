import { v1Route } from "@/lib/api/v1";
import { listDeliveriesResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The endpoint's delivery log: every event, its attempts and how each went. */
export const GET = v1Route<{ id: string }>("webhooks:read", (request, caller, params) =>
  listDeliveriesResponse(request, { workspaceId: caller.workspaceId }, params.id)
);
