import type { NextRequest } from "next/server";
import { z } from "zod";
import { v1Data, v1Error } from "@/lib/api/v1";
import {
  createEndpoint,
  createEndpointSchema,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  updateEndpoint,
  updateEndpointSchema,
  type WebhookOwner,
} from "./endpoints";

/**
 * The webhook endpoint handlers, written once and mounted twice: under
 * /v1/webhooks for one workspace, and under /v1/partner/webhooks for a
 * partner's endpoints that hear all of its workspaces. The door in front
 * decides the owner; nothing here takes an owner from the request.
 */

const NOT_FOUND = "That webhook endpoint was not found.";

export async function listEndpointsResponse(owner: WebhookOwner): Promise<Response> {
  return v1Data({ endpoints: await listEndpoints(owner) });
}

export async function createEndpointResponse(request: NextRequest, owner: WebhookOwner): Promise<Response> {
  const parsed = createEndpointSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message;
    return v1Error(
      message && message !== "Required" && !message.startsWith("Invalid")
        ? message
        : "Send an https url and at least one event."
    );
  }
  const result = await createEndpoint(owner, parsed.data);
  if (!result.ok) return v1Error(result.error, 409);
  // The only time the secret leaves the server. It cannot be shown again.
  return v1Data({ ...result.endpoint, secret: result.secret }, 201);
}

export async function updateEndpointResponse(
  request: NextRequest,
  owner: WebhookOwner,
  id: string
): Promise<Response> {
  const parsed = updateEndpointSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message;
    return v1Error(message?.includes("https") ? message : "Send url, events, description or enabled to change.");
  }
  const endpoint = await updateEndpoint(owner, id, parsed.data);
  return endpoint ? v1Data(endpoint) : v1Error(NOT_FOUND, 404);
}

export async function deleteEndpointResponse(owner: WebhookOwner, id: string): Promise<Response> {
  return (await deleteEndpoint(owner, id)) ? v1Data({ id, deleted: true }) : v1Error(NOT_FOUND, 404);
}

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(100).nullable().default(null),
});

export async function listDeliveriesResponse(
  request: NextRequest,
  owner: WebhookOwner,
  id: string
): Promise<Response> {
  const search = request.nextUrl.searchParams;
  const page = pageSchema.safeParse({ limit: search.get("limit") ?? undefined, cursor: search.get("cursor") });
  if (!page.success) return v1Error("limit must be 1 to 100.");
  const result = await listDeliveries(owner, id, page.data);
  return result ? v1Data(result) : v1Error(NOT_FOUND, 404);
}
