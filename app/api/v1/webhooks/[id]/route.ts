import { v1Route } from "@/lib/api/v1";
import { deleteEndpointResponse, updateEndpointResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = v1Route<{ id: string }>("webhooks:write", (request, caller, params) =>
  updateEndpointResponse(request, { workspaceId: caller.workspaceId }, params.id)
);

export const DELETE = v1Route<{ id: string }>("webhooks:write", (_request, caller, params) =>
  deleteEndpointResponse({ workspaceId: caller.workspaceId }, params.id)
);
