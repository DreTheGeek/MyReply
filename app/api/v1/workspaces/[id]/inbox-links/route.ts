import { partnerRoute, v1Data, v1Error } from "@/lib/api/v1";
import { createInboxLink, inboxLinkSchema } from "@/lib/partners/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A signed, expiring link to the hosted inbox for this workspace. */
export const POST = partnerRoute<{ id: string }>("workspaces:write", async (request, partner, params) => {
  const body: unknown = await request.json().catch(() => ({}));
  const parsed = inboxLinkSchema.safeParse(body ?? {});
  if (!parsed.success) return v1Error("expiresInMinutes is optional, 1 to 720. Nothing else is accepted.");

  const result = await createInboxLink(partner.partnerId, params.id, parsed.data);
  if (!result.ok) return v1Error(result.error, result.status);
  return v1Data({ url: result.url, expiresAt: result.expiresAt }, 201);
});
