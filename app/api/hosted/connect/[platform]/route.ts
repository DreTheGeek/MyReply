import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { missingConnectEnv } from "@/lib/channels/connect-routes";
import { getChannelAdapter } from "@/lib/channels/registry";
import { prisma } from "@/lib/db/client";
import { getBaseUrl, getMissingInstagramOAuthEnv } from "@/lib/env";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";
import { returnUrlWithOutcome, verifyHostedToken } from "@/lib/partners/links";
import { HOSTED_CONNECT_PLATFORMS } from "@/lib/partners/workspaces";
import { createOAuthState } from "@/lib/security/oauth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ platform: string }> };

const platformSchema = z.enum(HOSTED_CONNECT_PLATFORMS);

/** Each platform's callback, which is the redirect URL registered with the platform. */
const CALLBACK_PATH: Record<z.infer<typeof platformSchema>, string> = {
  instagram: "/api/instagram/callback",
  facebook: "/api/channels/facebook/callback",
};

const STORED_PLATFORM = { instagram: "INSTAGRAM", facebook: "FACEBOOK" } as const;

function expiredPage(): NextResponse {
  return new NextResponse(
    "This link has expired. Go back to the app you came from and start again.",
    { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

/**
 * Start connecting an account from a partner's hosted connect link. The link
 * is the authorization: it was signed when the partner minted it, it names
 * the workspace, and it expires. The OAuth state carries the partner and the
 * return URL through the platform's redirect, so the callback sends the
 * person back to the partner's app rather than to a dashboard they never see.
 */
export async function GET(request: NextRequest, { params }: RouteProps): Promise<NextResponse> {
  const limit = checkRateLimit(`hosted-connect:${clientAddress(request)}`, 30, 60_000);
  if (!limit.allowed) {
    return new NextResponse("Too many attempts. Wait a minute and try again.", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds), "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const platform = platformSchema.safeParse((await params).platform);
  if (!platform.success) return expiredPage();

  const claims = verifyHostedToken(request.nextUrl.searchParams.get("t"), "connect");
  if (!claims || !claims.r) return expiredPage();
  if (claims.pl && !claims.pl.includes(platform.data)) return expiredPage();

  const workspace = await prisma.workspace.findFirst({
    where: { id: claims.w, partnerId: claims.p, partner: { disabledAt: null } },
    select: { id: true },
  });
  if (!workspace) return expiredPage();

  const missing =
    platform.data === "instagram" ? getMissingInstagramOAuthEnv() : missingConnectEnv("FACEBOOK");
  if (missing.length > 0) {
    console.error(`[Hosted connect] ${platform.data} is not configured: missing ${missing.join(", ")}`);
    return NextResponse.redirect(
      returnUrlWithOutcome(claims.r, {
        status: "unavailable",
        platform: platform.data,
        workspaceId: workspace.id,
      })
    );
  }

  const state = createOAuthState(workspace.id, { partnerId: claims.p, returnUrl: claims.r });
  const adapter = getChannelAdapter(STORED_PLATFORM[platform.data]);
  return NextResponse.redirect(
    adapter.auth.authorizationUrl({
      redirectUri: `${getBaseUrl()}${CALLBACK_PATH[platform.data]}`,
      state,
    })
  );
}
