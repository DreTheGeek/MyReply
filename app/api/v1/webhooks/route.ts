import { v1Route } from "@/lib/api/v1";
import { createEndpointResponse, listEndpointsResponse } from "@/lib/webhooks/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This workspace's webhook endpoints. */
export const GET = v1Route("webhooks:read", (_request, caller) =>
  listEndpointsResponse({ workspaceId: caller.workspaceId })
);

/** Add an endpoint. The answer carries its signing secret, shown this once. */
export const POST = v1Route("webhooks:write", (request, caller) =>
  createEndpointResponse(request, { workspaceId: caller.workspaceId })
);
