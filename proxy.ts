import { NextResponse, type NextRequest } from "next/server";

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

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
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
  matcher: [
    "/dashboard/:path*",
    "/overview/:path*",
    "/campaigns/:path*",
    "/contacts/:path*",
    "/inbox/:path*",
    "/answers/:path*",
    "/logs/:path*",
    "/settings/:path*",
    "/diagnostics/:path*",
    "/onboarding/:path*",
    "/automations/:path*",
    "/login",
  ],
};
