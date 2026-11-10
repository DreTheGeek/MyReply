import { NextResponse } from "next/server";
import {
  missingConnectEnv,
  noticeKey,
  parsePlatformSegment,
} from "@/lib/channels/connect-routes";
import { getChannelAdapter } from "@/lib/channels/registry";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/security/oauth-state";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

type RouteProps = { params: Promise<{ platform: string }> };

/**
 * Start connecting an account on a platform. Owners and admins only. The
 * signed state binds the redirect back to this workspace for ten minutes.
 */
export async function GET(_request: Request, { params }: RouteProps): Promise<NextResponse> {
  const baseUrl = getBaseUrl();
  const platform = parsePlatformSegment((await params).platform);
  if (!platform) {
    return NextResponse.json({ success: false, error: "Unknown platform" }, { status: 404 });
  }
  const key = noticeKey(platform);

  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${baseUrl}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?${key}=forbidden`);
  }

  if (missingConnectEnv(platform).length > 0) {
    return NextResponse.redirect(`${baseUrl}/settings?${key}=misconfigured`);
  }

  const redirectUri = `${baseUrl}/api/channels/${key}/callback`;
  const state = createOAuthState(context.workspaceId);
  return NextResponse.redirect(
    getChannelAdapter(platform).auth.authorizationUrl({ redirectUri, state })
  );
}
