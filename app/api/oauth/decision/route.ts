import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { issueAuthorizationCode } from "@/lib/oauth/codes";
import { AUTHORIZE_PATH, resolveIssuer } from "@/lib/oauth/config";
import { verifyConsentRequest } from "@/lib/oauth/consent-request";
import { buildErrorRedirect } from "@/lib/oauth/errors";
import { getMembershipRole } from "@/lib/oauth/membership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the consent screen's Approve and Deny buttons land.
 *
 * The request the user read is carried here as a signed blob rather than as
 * query parameters, so nothing about it can be edited between being shown and
 * being acted on. That signature is also the CSRF defence: it is bound to the
 * signed-in user and expires in ten minutes, so another site cannot forge a
 * submission and one minted for somebody else is refused.
 */

/** A redirect that works for private-use schemes too, which URL-validating helpers refuse. */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

function problem(status: number, message: string): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return problem(400, "This form could not be read. Start the connection again.");
  }

  const consentToken = form.get("consent");
  const consent = verifyConsentRequest(
    typeof consentToken === "string" ? consentToken : null
  );

  if (!consent) {
    return problem(
      400,
      "This approval has expired or could not be verified. Start the connection again from the app."
    );
  }

  const issuer = resolveIssuer(request);
  const session = await auth();

  if (!session?.user?.id) {
    // The session lapsed while the screen was open. Rebuild the original
    // request from the signed blob so signing in returns them to it, rather
    // than dropping them on the dashboard with the connection abandoned.
    const search = new URLSearchParams({
      client_id: consent.clientId,
      redirect_uri: consent.redirectUri,
      response_type: "code",
      scope: consent.scope,
      resource: consent.resource,
      code_challenge: consent.codeChallenge,
      code_challenge_method: consent.codeChallengeMethod,
    });
    if (consent.state !== null) search.set("state", consent.state);

    const returnTo = `${AUTHORIZE_PATH}?${search.toString()}`;
    return seeOther(`/login?callbackUrl=${encodeURIComponent(returnTo)}`);
  }

  if (session.user.id !== consent.userId) {
    return problem(
      403,
      "This approval was prepared for a different account. Start the connection again."
    );
  }

  const denied = form.get("decision") !== "approve";
  if (denied) {
    return seeOther(
      buildErrorRedirect({
        redirectUri: consent.redirectUri,
        error: "access_denied",
        description: "The user denied this connection.",
        state: consent.state,
        issuer,
      })
    );
  }

  const workspaceId = form.get("workspaceId");
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return problem(400, "Pick a workspace before approving.");
  }

  // Membership is checked here, and checked again when the code is exchanged.
  // A workspace id is a choice, never a grant: naming one you do not belong to
  // gets you nothing.
  const role = await getMembershipRole(session.user.id, workspaceId);
  if (!role) {
    return problem(403, "You are not a member of that workspace.");
  }

  const code = await issueAuthorizationCode({
    clientRecordId: consent.clientRecordId,
    userId: session.user.id,
    workspaceId,
    redirectUri: consent.redirectUri,
    scope: consent.scope,
    resource: consent.resource,
    codeChallenge: consent.codeChallenge,
  });

  const target = new URL(consent.redirectUri);
  target.searchParams.set("code", code);
  if (consent.state !== null) {
    // Passed back exactly as it arrived.
    target.searchParams.set("state", consent.state);
  }
  // RFC 9207: name the authorization server that issued this response.
  target.searchParams.set("iss", issuer);

  return seeOther(target.toString());
}
