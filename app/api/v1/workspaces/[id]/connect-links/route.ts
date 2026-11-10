import { partnerRoute, v1Data, v1Error } from "@/lib/api/v1";
import { connectLinkSchema, createConnectLink } from "@/lib/partners/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A signed link to the hosted "connect your accounts" page for this
 * workspace. When the person finishes, they land on returnUrl with
 * connect_status, platform and workspace_id added to it.
 */
export const POST = partnerRoute<{ id: string }>("workspaces:write", async (request, partner, params) => {
  const parsed = connectLinkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return v1Error("returnUrl is required. platforms and expiresInMinutes (up to 60) are optional.");
  }

  const result = await createConnectLink(partner.partnerId, params.id, parsed.data);
  if (!result.ok) return v1Error(result.error, result.status);
  return v1Data({ url: result.url, expiresAt: result.expiresAt }, 201);
});
