import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";

/**
 * What a hosted page shows instead of this product's name. Every value is
 * re-checked here before it reaches a style or an <img>, even though it was
 * checked when saved: a colour goes into an inline style, so only a plain hex
 * colour is ever used, and a logo only from an https URL.
 */

export interface PartnerBrand {
  partnerId: string;
  brandName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  showPoweredBy: boolean;
  customDomain: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function safeColor(value: string | null | undefined, fallback: string): string {
  return value && HEX.test(value) ? value : fallback;
}

export function safeLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function loadPartnerBrand(partnerId: string): Promise<PartnerBrand | null> {
  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, disabledAt: null },
    select: {
      id: true,
      brandName: true,
      logoUrl: true,
      primaryColor: true,
      accentColor: true,
      showPoweredBy: true,
      customDomain: true,
    },
  });
  if (!partner) return null;
  return {
    partnerId: partner.id,
    brandName: partner.brandName,
    logoUrl: safeLogoUrl(partner.logoUrl),
    primaryColor: safeColor(partner.primaryColor, "#111827"),
    accentColor: safeColor(partner.accentColor, "#2563EB"),
    showPoweredBy: partner.showPoweredBy,
    customDomain: partner.customDomain,
  };
}

/**
 * Whether a hosted page may be served on this host: this deployment's own
 * domain, or the partner's own custom domain. Serving one partner's page on
 * another partner's domain would put the wrong brand in front of someone.
 */
export function isHostedHostAllowed(host: string | null, brand: PartnerBrand): boolean {
  if (!host) return false;
  const requested = host.toLowerCase();
  let own = "";
  try {
    own = new URL(getBaseUrl()).host.toLowerCase();
  } catch {
    own = "";
  }
  if (requested === own) return true;
  return brand.customDomain !== null && requested === brand.customDomain.toLowerCase();
}
