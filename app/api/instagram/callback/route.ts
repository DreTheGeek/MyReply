import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { storeConnectedAccounts } from "@/lib/channels/connect";
import { connectOutcomeUrl, mayFinishConnect } from "@/lib/channels/connect-authorize";
import { getChannelAdapter } from "@/lib/channels/registry";
import { verifyOAuthState } from "@/lib/security/oauth-state";

/**
 * Finish connecting an Instagram account. Signed in here, or from a partner's
 * hosted connect link; see lib/channels/connect-authorize.ts.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();
  const go = (status: string, extra: { connected?: number; settingsUrl?: string } = {}): NextResponse =>
    NextResponse.redirect(connectOutcomeUrl(state, { platformKey: "instagram", status, ...extra }));

  if (error) return go("denied");
  if (!code || !state) return go("invalid");

  const permission = await mayFinishConnect(state);
  if (permission === "login") return NextResponse.redirect(`${baseUrl}/login`);
  if (permission === "forbidden") return go("forbidden");

  try {
    const adapter = getChannelAdapter("INSTAGRAM");
    // The adapter trades the code for a long-lived token and reads the
    // account's own id: for Instagram the professional account id (user_id)
    // that webhooks and the messaging API key off, not the app-scoped `id`.
    // Instagram grants exactly one account per approval.
    const grants = await adapter.auth.completeConnection({
      code,
      redirectUri: `${baseUrl}/api/instagram/callback`,
    });
    if (grants.length === 0) throw new Error("Instagram returned no account to connect");

    const result = await storeConnectedAccounts({
      adapter,
      grants,
      workspaceId: state.workspaceId,
    });

    // Two different refusals, two different things to do about them. Sending
    // someone who hit the plan cap to "already connected" would tell them to
    // go find an account nobody else has.
    if (result.connected === 0) return go(result.refused ?? "none_granted");

    return go("connected", {
      connected: result.connected,
      settingsUrl: `${baseUrl}/dashboard?connected=true`,
    });
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
      .catch((recordError: unknown) => {
        console.error("[Instagram Callback] Could not record the failure", recordError);
      });

    return go("failed");
  }
}
