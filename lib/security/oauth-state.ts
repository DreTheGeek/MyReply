import { createHmac, timingSafeEqual } from "crypto";
import { requireEnv } from "@/lib/env";

/**
 * The signed `state` carried through a platform's OAuth redirect.
 *
 * It binds the redirect back to the workspace that started the connection,
 * HMAC-signed with NEXTAUTH_SECRET and good for ten minutes, so a forged or
 * replayed callback cannot attach an account to another workspace. Platform
 * neutral: every adapter's connect flow carries the same state.
 */

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Present when the connection was started from a partner's hosted connect
 * link rather than by someone signed in here. The partner vouched for the
 * workspace when it minted the link, so the callback checks the workspace is
 * still the partner's instead of asking for a session, and sends the person
 * back to the partner's app.
 */
export interface HostedConnect {
  partnerId: string;
  returnUrl: string;
}

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
  hosted?: HostedConnect;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(workspaceId: string, hosted?: HostedConnect): string {
  const payload = base64UrlEncode(
    JSON.stringify({
      workspaceId,
      ts: Date.now(),
      ...(hosted ? { hosted } : {}),
    } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId) {
      return null;
    }

    // Reject a missing or non-numeric timestamp. `Date.now() - "abc"` is NaN,
    // and every comparison against NaN is false, so a non-numeric ts would
    // otherwise pass the age check and never expire. A ts in the future is
    // rejected for the same reason: it has not aged at all.
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }

    const age = Date.now() - parsed.ts;
    if (age < 0 || age > STATE_MAX_AGE_MS) {
      return null;
    }

    // Signed by us, but checked for shape anyway: a malformed hosted block is
    // refused outright rather than half trusted.
    if (parsed.hosted !== undefined) {
      const hosted: unknown = parsed.hosted;
      if (
        typeof hosted !== "object" ||
        hosted === null ||
        typeof (hosted as HostedConnect).partnerId !== "string" ||
        typeof (hosted as HostedConnect).returnUrl !== "string" ||
        !(hosted as HostedConnect).returnUrl.startsWith("https://")
      ) {
        return null;
      }
      return {
        workspaceId: parsed.workspaceId,
        ts: parsed.ts,
        hosted: {
          partnerId: (hosted as HostedConnect).partnerId,
          returnUrl: (hosted as HostedConnect).returnUrl,
        },
      };
    }

    return { workspaceId: parsed.workspaceId, ts: parsed.ts };
  } catch {
    return null;
  }
}

