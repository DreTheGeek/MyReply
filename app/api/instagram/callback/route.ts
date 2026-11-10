import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import { getChannelAdapter } from "@/lib/channels/registry";
import { verifyOAuthState } from "@/lib/security/oauth-state";
import { encryptToken } from "@/lib/security/token-crypto";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=forbidden`);
  }

  try {
    const adapter = getChannelAdapter("INSTAGRAM");
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    // The adapter trades the code for a long-lived token and reads the
    // account's own id: for Instagram the professional account id (user_id)
    // that webhooks and the messaging API key off, not the app-scoped `id`.
    // Instagram grants exactly one account per approval.
    const [grant] = await adapter.auth.completeConnection({ code, redirectUri });
    if (!grant) throw new Error("Instagram returned no account to connect");
    const instagramId = grant.externalId;
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      // Two different refusals, two different things to do about them. Sending
      // someone who hit the plan cap to "already connected" would tell them to
      // go find an account nobody else has.
      return NextResponse.redirect(
        `${baseUrl}/settings?instagram=${connection.reason}`
      );
    }

    const encryptedToken = encryptToken(grant.accessToken);
    const tokenExpiresAt = grant.expiresAt;

    let webhookSubscribed = false;
    try {
      webhookSubscribed = await adapter.auth.subscribeToEvents({
        platform: adapter.platform,
        accountExternalId: instagramId,
        accessToken: grant.accessToken,
      });
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    const data = {
      username: grant.username,
      name: grant.name,
      accessToken: encryptedToken,
      tokenExpiresAt,
      webhookSubscribed,
      ...(grant.authorizedByExternalId
        ? { authorizedByExternalId: grant.authorizedByExternalId }
        : {}),
    };
    const existing = await prisma.instagramAccount.findUnique({ where: { instagramId } });
    if (existing) {
      const updated = await prisma.instagramAccount.updateMany({
        where: { id: existing.id, workspaceId: state.workspaceId }, data,
      });
      if (!updated.count) return NextResponse.redirect(`${baseUrl}/settings?instagram=already_connected`);
    } else {
      await prisma.instagramAccount.create({ data: { ...data, workspaceId: state.workspaceId, instagramId, platform: adapter.platform } });
    }

    return NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The reason is kept server side: in the log above and on the workspace's
    // operational event, where an operator can read it. It used to ride on the
    // redirect URL and be printed on the settings page, which put internal
    // error text (token exchange responses, Graph errors) in front of whoever
    // was connecting, and into their browser history.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(`${baseUrl}/settings?instagram=failed`);
  }
}
