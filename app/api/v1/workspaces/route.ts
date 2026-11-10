import { z } from "zod";
import { partnerRoute, v1Data, v1Error } from "@/lib/api/v1";
import {
  createPartnerWorkspace,
  createWorkspaceSchema,
  listPartnerWorkspaces,
} from "@/lib/partners/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(100).nullable().default(null),
  externalId: z.string().min(1).max(200).nullable().default(null),
});

/** The partner's workspaces, newest first, a page at a time. */
export const GET = partnerRoute("workspaces:read", async (request, partner) => {
  const search = request.nextUrl.searchParams;
  const parsed = listQuerySchema.safeParse({
    limit: search.get("limit") ?? undefined,
    cursor: search.get("cursor"),
    externalId: search.get("externalId"),
  });
  if (!parsed.success) return v1Error("limit must be 1 to 100.");

  return v1Data(await listPartnerWorkspaces(partner.partnerId, parsed.data));
});

/**
 * Create a workspace for one of the partner's users. Sending the same
 * externalId again returns the workspace made the first time, with 200
 * instead of 201, so a retried call never makes a second one.
 */
export const POST = partnerRoute("workspaces:write", async (request, partner) => {
  const parsed = createWorkspaceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return v1Error("A name is required. externalId and timezone are optional; nothing else is accepted.");
  }

  const result = await createPartnerWorkspace(partner.partnerId, parsed.data);
  return v1Data({ ...result.workspace, created: result.created }, result.created ? 201 : 200);
});
