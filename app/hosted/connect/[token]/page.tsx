import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { isHostedHostAllowed, loadPartnerBrand, type PartnerBrand } from "@/lib/partners/brand";
import { verifyHostedToken, type HostedLinkClaims } from "@/lib/partners/links";
import { accountStatus, type AccountStatus } from "@/lib/partners/workspaces";
import { HostedExpired, HostedShell } from "../../hosted-shell";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook Page" };
const STORED_TO_KEY: Record<string, string> = { INSTAGRAM: "instagram", FACEBOOK: "facebook" };

const STATUS_COPY: Record<AccountStatus, string> = {
  connected: "Connected",
  needs_reconnect: "Needs to be connected again",
  events_off: "Connected, but not receiving new messages. Connect again to fix it.",
};

interface Loaded {
  claims: HostedLinkClaims;
  brand: PartnerBrand;
  accounts: { id: string; platform: string; username: string; status: AccountStatus }[];
}

async function load(token: string): Promise<Loaded | null> {
  const claims = verifyHostedToken(token, "connect");
  if (!claims) return null;

  const brand = await loadPartnerBrand(claims.p);
  if (!brand) return null;
  if (!isHostedHostAllowed((await headers()).get("host"), brand)) return null;

  const workspace = await prisma.workspace.findFirst({
    where: { id: claims.w, partnerId: claims.p },
    select: {
      instagramAccounts: {
        orderBy: { connectedAt: "asc" },
        select: {
          id: true,
          platform: true,
          username: true,
          accessToken: true,
          tokenExpiresAt: true,
          webhookSubscribed: true,
        },
      },
    },
  });
  if (!workspace) return null;

  return {
    claims,
    brand,
    // The token is read only to judge the account's state; it never reaches the page.
    accounts: workspace.instagramAccounts.map((account) => ({
      id: account.id,
      platform: STORED_TO_KEY[account.platform] ?? account.platform.toLowerCase(),
      username: account.username,
      status: accountStatus(account),
    })),
  };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const claims = verifyHostedToken((await params).token, "connect");
  const brand = claims ? await loadPartnerBrand(claims.p) : null;
  return {
    title: brand ? `Connect your accounts | ${brand.brandName}` : "Link expired",
    description: null,
    keywords: null,
    manifest: null,
    appleWebApp: { title: brand?.brandName ?? "" },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/**
 * "Connect your accounts", in the partner's brand. The person picks a
 * platform, approves on the platform's own screen, and lands back in the
 * partner's app. The buttons open at the top level because the platforms
 * refuse to show their approval screen inside a frame.
 */
export default async function HostedConnectPage({ params }: PageProps): Promise<ReactNode> {
  const { token } = await params;
  const loaded = await load(token);
  if (!loaded) return <HostedExpired />;

  const { claims, brand, accounts } = loaded;
  const platforms = claims.pl ?? ["instagram", "facebook"];
  const baseUrl = getBaseUrl();

  return (
    <HostedShell brand={brand}>
      <h1 className="text-2xl font-semibold">Connect your accounts</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Connect the accounts you want {brand.brandName} to answer messages and comments on. You
        approve it on the platform&apos;s own screen and can remove it there at any time.
      </p>

      <ul className="mt-6 space-y-3">
        {platforms.map((platform) => {
          const connected = accounts.filter((account) => account.platform === platform);
          return (
            <li key={platform} className="rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{PLATFORM_LABEL[platform] ?? platform}</span>
                <a
                  href={`${baseUrl}/api/hosted/connect/${platform}?t=${encodeURIComponent(token)}`}
                  target="_top"
                  rel="noopener"
                  className="rounded-md px-3 py-2 text-sm font-medium text-white"
                  style={{ backgroundColor: brand.accentColor }}
                >
                  {connected.length > 0 ? "Connect another" : "Connect"}
                </a>
              </div>
              {connected.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm text-zinc-600">
                  {connected.map((account) => (
                    <li key={account.id}>
                      @{account.username}: {STATUS_COPY[account.status]}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {claims.r ? (
        <a
          href={claims.r}
          target="_top"
          rel="noopener"
          className="mt-8 block text-center text-sm font-medium"
          style={{ color: brand.primaryColor }}
        >
          Back to {brand.brandName}
        </a>
      ) : null}
    </HostedShell>
  );
}
