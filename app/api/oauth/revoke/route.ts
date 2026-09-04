import { NextResponse } from "next/server";
import {
  CORS_HEADERS,
  NO_STORE_HEADERS,
  corsPreflight,
  oauthErrorResponse,
} from "@/lib/oauth/errors";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";
import { revokeTokenByPlaintext } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 7009 token revocation, so a client can hand access back when a user
 * disconnects it rather than leaving a live token behind.
 *
 * Always answers 200, including for a token that does not exist. That is what
 * the RFC requires, and it stops this endpoint being used to ask whether a
 * given string is a real token.
 */

const REVOCATIONS_PER_MINUTE = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const limit = checkRateLimit(
    `oauth:revoke:${clientAddress(request)}`,
    REVOCATIONS_PER_MINUTE,
    60 * 1000
  );

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Too many revocation requests from this address.",
      },
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          ...NO_STORE_HEADERS,
          "Retry-After": String(limit.retryAfterSeconds),
        },
      }
    );
  }

  const text = await request.text().catch(() => "");
  const token = new URLSearchParams(text).get("token");

  if (!token) {
    return oauthErrorResponse("invalid_request", "token is required.");
  }

  await revokeTokenByPlaintext(token);

  return new NextResponse(null, {
    status: 200,
    headers: { ...CORS_HEADERS, ...NO_STORE_HEADERS },
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return corsPreflight();
}
