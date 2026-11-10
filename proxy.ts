import { NextResponse, type NextRequest } from "next/server";
import { verifyHostedToken, type HostedLinkKind } from "@/lib/partners/links";
import { buildCsp, frameAncestorsFor } from "@/lib/security/csp";

/**
 * Every signed-in surface. The dashboard layout is the real gate, since it
 * calls auth() server side, but listing the routes here means an unauthenticated
 * visitor is sent to /login carrying a callbackUrl and lands back where they
 * were trying to go.
 *
 * /templates is deliberately absent: it is one route serving the public
 * marketing library signed out and the in-app gallery signed in.
 */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/overview",
  "/campaigns",
  "/contacts",
  "/inbox",
  "/answers",
  "/logs",
  "/settings",
  "/diagnostics",
  "/onboarding",
  "/automations",
];

const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

/**
 * Marker the dashboard layout adds when auth() rejected the cookie the browser
 * is holding. Middleware cannot tell a live session from a dead one, because
 * validating it means a database read, so the server component that CAN tell
 * says so in the URL.
 */
export const STALE_SESSION_PARAM = "session";
export const STALE_SESSION_VALUE = "expired";

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIES.some((name) => request.cookies.has(name));
}

/**
 * Whether this request came in on a partner's own domain rather than ours.
 *
 * Only decided when NEXTAUTH_URL is set, which it always is in production:
 * without it there is no way to tell our host from anyone else's, and guessing
 * wrong would lock the dashboard out. Vercel's preview hosts and local
 * development are always ours.
 */
export function isPartnerHost(host: string | null, baseUrl: string | undefined): boolean {
  if (!host || !baseUrl) return false;
  let own: string;
  try {
    own = new URL(baseUrl).host.toLowerCase();
  } catch {
    return false;
  }
  const requested = host.toLowerCase();
  if (requested === own) return false;
  if (requested.endsWith(".vercel.app")) return false;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(requested)) return false;
  return true;
}

/** What a partner's domain may serve: its hosted pages and what they need. */
const PARTNER_HOST_PREFIXES = ["/hosted/", "/api/hosted/", "/_next/"];

const HOSTED_PAGE = /^\/hosted\/(connect|inbox)\/([^/]+)\/?$/;

/**
 * The CSP for a hosted page: the usual policy, with frame-ancestors set to the
 * origins the partner registered, as signed into the link when it was minted.
 * Anything that does not verify may be framed by nobody.
 */
export function hostedPageCsp(pathname: string): string {
  const match = HOSTED_PAGE.exec(pathname);
  if (!match) return buildCsp("'none'");
  let token: string;
  try {
    token = decodeURIComponent(match[2]);
  } catch {
    return buildCsp("'none'");
  }
  const claims = verifyHostedToken(token, match[1] as HostedLinkKind);
  return buildCsp(claims ? frameAncestorsFor(claims.fa) : "'none'");
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // A partner's domain is theirs: it serves the hosted pages and nothing of
  // ours, so the dashboard and sign-in never appear under their name.
  if (isPartnerHost(request.headers.get("host"), process.env.NEXTAUTH_URL)) {
    if (!PARTNER_HOST_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  if (pathname.startsWith("/hosted/")) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", hostedPageCsp(pathname));
    return response;
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isLogin = pathname === "/login";
  const hasCookie = hasSessionCookie(request);

  if (isProtected && !hasCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isLogin && hasCookie) {
    // A cookie is not a session. Sign out on one device and every other device
    // keeps a cookie whose row is gone; the same happens when a session
    // expires or the database is restored.
    //
    // Without this branch that state was an unrecoverable loop: /dashboard let
    // the request through because a cookie existed, the layout's auth() came
    // back null and redirected to /login, and this handler bounced it straight
    // back to /dashboard. The person never saw the sign-in form and the only
    // way out was clearing cookies by hand.
    //
    // So when the layout tells us the cookie is dead, delete it and let the
    // form render. Deleting rather than merely passing through means a reload
    // cannot re-enter the loop.
    if (
      request.nextUrl.searchParams.get(STALE_SESSION_PARAM) ===
      STALE_SESSION_VALUE
    ) {
      const response = NextResponse.next();
      for (const name of SESSION_COOKIES) {
        response.cookies.set(name, "", { path: "/", maxAge: 0 });
      }
      return response;
    }

    // Honour callbackUrl rather than always landing on the dashboard. The OAuth
    // consent screen sends the user here with the pending authorization request
    // in callbackUrl, so discarding it would drop the request and leave the
    // client waiting on a Connect that silently never completes.
    //
    // Only a same-origin absolute path is followed. A value starting with "//"
    // is protocol relative and would resolve to another host, which is the
    // classic open redirect, so it falls through to the dashboard.
    const callbackUrl = request.nextUrl.searchParams.get("callbackUrl");
    const target =
      callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
        ? callbackUrl
        : "/dashboard";
    return NextResponse.redirect(new URL(target, request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Every route except static assets: a partner's domain has to be held to its
  // hosted pages wherever the request lands, and the hosted pages need their
  // framing header. The sign-in redirects below still only act on their own
  // prefixes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon-|apple-touch-icon).*)"],
};
