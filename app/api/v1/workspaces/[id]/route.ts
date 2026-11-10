import { partnerRoute, v1Data, v1Error } from "@/lib/api/v1";
import {
  deletePartnerWorkspace,
  partnerWorkspaceStatus,
  updatePartnerWorkspace,
  updateWorkspaceSchema,
} from "@/lib/partners/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = "That workspace was not found for this key.";

/** One workspace's status: its connected accounts and how each is doing. */
export const GET = partnerRoute<{ id: string }>("workspaces:read", async (_request, partner, params) => {
  const status = await partnerWorkspaceStatus(partner.partnerId, params.id);
  return status ? v1Data(status) : v1Error(NOT_FOUND, 404);
});

export const PATCH = partnerRoute<{ id: string }>("workspaces:write", async (request, partner, params) => {
  const parsed = updateWorkspaceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return v1Error("Send name, externalId or timezone to change.");

  const result = await updatePartnerWorkspace(partner.partnerId, params.id, parsed.data);
  if (result === "not_found") return v1Error(NOT_FOUND, 404);
  if (result === "external_id_taken") {
    return v1Error("Another of your workspaces already has that externalId.", 409);
  }
  return v1Data(result);
});

/** Delete the workspace and everything under it. Recorded in the audit log. */
export const DELETE = partnerRoute<{ id: string }>("workspaces:write", async (_request, partner, params) => {
  const deleted = await deletePartnerWorkspace(partner.partnerId, params.id, partner.keyId);
  return deleted ? v1Data({ id: params.id, deleted: true }) : v1Error(NOT_FOUND, 404);
});
