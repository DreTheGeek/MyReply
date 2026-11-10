import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { storeConnectedAccounts } from "@/lib/channels/connect";
import { noticeKey, parsePlatformSegment } from "@/lib/channels/connect-routes";
import { PLATFORM_LABELS } from "@/lib/channels/platforms";
import { getChannelAdapter } from "@/lib/channels/registry";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { verifyOAuthState } from "@/lib/security/oauth-state";
import { canManageWorkspace } from "@/lib/workspace-access";

type RouteProps = { params: Promise<{ platform: string }> };

/**
 * Finish connecting: verify the signed state, confirm the person may manage
 * that workspace, trade the code for the granted accounts, and store them.
 *
 * Any failure's reason stays server side, in the log and on the workspace's
 * operational events; the redirect says only that it failed.
 */
export async function GET(request: NextRequest, { params }: RouteProps): Promise<NextResponse> {
  const baseUrl = getBaseUrl();
  const platform = parsePlatformSegment((await params).platform);
  if (!platform) {
    return NextResponse.json({ success: false, error: "Unknown platform" }, { status: 404 });
  }
  const key = noticeKey(platform);
  const search = request.nextUrl.searchParams;

  if (search.get("error")) {
    return NextResponse.redirect(`${baseUrl}/settings?${key}=denied`);
  }
  const code = search.get("code");
  const state = verifyOAuthState(search.get("state"));
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?${key}=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?${key}=forbidden`);
  }

  const adapter = getChannelAdapter(platform);
  try {
    const grants = await adapter.auth.completeConnection({
      code,
      redirectUri: `${baseUrl}/api/channels/${key}/callback`,
    });
    const result = await storeConnectedAccounts({
      adapter,
      grants,
      workspaceId: state.workspaceId,
    });
    if (result.connected === 0) {
      return NextResponse.redirect(
        `${baseUrl}/settings?${key}=${result.refused ?? "none_granted"}`
      );
    }
    return NextResponse.redirect(`${baseUrl}/settings?${key}=connected&count=${result.connected}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Connect ${platform}] Error:`, error);
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: `${PLATFORM_LABELS[adapter.platform]} connection failed`,
          payload: { reason },
        },
      })
      .catch((recordError: unknown) => {
        console.error("[Connect] Could not record the failure", recordError);
      });
    return NextResponse.redirect(`${baseUrl}/settings?${key}=failed`);
  }
}
