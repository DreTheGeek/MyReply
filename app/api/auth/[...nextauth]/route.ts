/**
 * NextAuth.js v5 route handler.
 *
 * The handlers come from lib/auth.ts. The only thing added here is a limiter
 * on the sign-in POST, because that endpoint sends an email to an address the
 * caller chooses. Unwrapped, a loop over it mail-bombs an arbitrary third
 * party from our verified sending domain, which costs deliverability
 * reputation rather than money, and burns the Resend quota so real customers
 * stop receiving their own links.
 *
 * Only the sign-in POST is limited. Session reads and callbacks go straight
 * through: they are frequent, cheap, and rate limiting them would log people
 * out of a busy dashboard.
 *
 * Note the limiter is in process and per instance (see lib/oauth/rate-limit).
 * On serverless that makes it a speed bump against one noisy client rather
 * than a real quota. A distributed limit belongs at the edge, and is on the
 * punch list rather than pretended at here.
 */

import { NextResponse } from "next/server";
import { handlers } from "@/lib/auth";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";

export const { GET } = handlers;

const WINDOW_MS = 15 * 60 * 1000;
/** Per address. Enough for a few genuine retries and a typo. */
const PER_IP = 10;
/** Per target address, so one mailbox cannot be flooded from many IPs. */
const PER_EMAIL = 5;

function isSignInRequest(request: Request): boolean {
  return new URL(request.url).pathname.includes("/signin/");
}

/** The submitted address, or null when the body is not a form we understand. */
async function readEmail(request: Request): Promise<string | null> {
  try {
    // Clone, because the real handler still needs to read this body.
    const form = await request.clone().formData();
    const email = form.get("email");
    return typeof email === "string" ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function tooMany(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: "Too many sign-in attempts. Try again shortly.",
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!isSignInRequest(request)) {
    return handlers.POST(request as never);
  }

  const byIp = checkRateLimit(
    `auth:signin:ip:${clientAddress(request)}`,
    PER_IP,
    WINDOW_MS
  );
  if (!byIp.allowed) return tooMany(byIp.retryAfterSeconds);

  const email = await readEmail(request);
  if (email) {
    const byEmail = checkRateLimit(
      `auth:signin:email:${email}`,
      PER_EMAIL,
      WINDOW_MS
    );
    if (!byEmail.allowed) return tooMany(byEmail.retryAfterSeconds);
  }

  return handlers.POST(request as never);
}
