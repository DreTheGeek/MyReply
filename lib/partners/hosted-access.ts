import { prisma } from "@/lib/db/client";
import { isHostedHostAllowed, loadPartnerBrand, type PartnerBrand } from "./brand";
import { verifyHostedToken, type HostedLinkClaims, type HostedLinkKind } from "./links";

/**
 * Everything a hosted page or its form checks before it does anything: the
 * link verifies and is the right kind, the partner is not disabled, the page
 * is being served on our domain or this partner's own, and the workspace is
 * still the partner's. Null for any failure, so the caller shows "this link
 * has expired" and says nothing about which check it was.
 */
export interface HostedAccess {
  claims: HostedLinkClaims;
  brand: PartnerBrand;
  workspaceId: string;
}

export async function loadHostedAccess(
  token: string | null | undefined,
  kind: HostedLinkKind,
  host: string | null
): Promise<HostedAccess | null> {
  const claims = verifyHostedToken(token, kind);
  if (!claims) return null;

  const brand = await loadPartnerBrand(claims.p);
  if (!brand) return null;
  if (!isHostedHostAllowed(host, brand)) return null;

  const workspace = await prisma.workspace.findFirst({
    where: { id: claims.w, partnerId: claims.p },
    select: { id: true },
  });
  if (!workspace) return null;

  return { claims, brand, workspaceId: workspace.id };
}
