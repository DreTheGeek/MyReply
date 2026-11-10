import type { NextConfig } from "next";
import { BASE_SECURITY_HEADERS, SECURITY_HEADERS } from "./lib/security/csp";

/**
 * Security headers.
 *
 * The app shipped with none of these. `proxy.ts` could not have added them
 * either: its matcher covers five page routes, so /api, /r, /reports and
 * /invite never pass through it. Setting them here covers every response.
 *
 * ON script-src AND 'unsafe-inline'. This was measured, not assumed. A
 * production build of one prerendered page emits seven inline <script> tags:
 * the theme switch, and six carrying the App Router's RSC flight payload
 * (`self.__next_f.push(...)`). That payload is different on every page and
 * changes on every build, so it cannot be pinned by hash. The only stricter
 * option is a per-request nonce, and a nonce has to be generated in
 * middleware, which would make every statically prerendered marketing page
 * dynamic. Those pages are the SEO surface, so that trade is not worth taking
 * yet.
 *
 * Critically, the two cannot be mixed: when a hash or nonce is present in
 * script-src, browsers IGNORE 'unsafe-inline' entirely. Adding the theme
 * script's hash "for good measure" would therefore block all six Next.js
 * payload scripts and white-screen the app. That is why no hash appears here.
 *
 * What this policy still buys, with 'unsafe-inline' present: an injected
 * <script src> pointing at an attacker's origin is refused, as are plugins,
 * a <base> takeover, and posting our forms to a third party. Framing is
 * denied outright, which is the clickjacking defence the dashboard's
 * destructive controls and the public /reports pages both needed. The one
 * exception is /hosted, the pages a partner app embeds, which only that
 * partner's own origins may frame.
 *
 * ON img-src AND media-src ALLOWING ANY https ORIGIN. Post thumbnails and reel
 * videos come from Instagram's CDN on signed URLs that expire and are never
 * stored, so there is no fixed host to list. Narrowing this would blank every
 * campaign thumbnail the first time Meta moved a bucket.
 */
// The policy itself is built in lib/security/csp.ts, so proxy.ts can give a
// hosted page the same policy with the partner's origins as frame-ancestors.
const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      // Every route but the hosted pages: framing denied outright.
      { source: "/:path((?!hosted/).*)", headers: SECURITY_HEADERS },
      // The hosted pages a partner may frame. proxy.ts sets their CSP, with the
      // partner's own origins as frame-ancestors, on every request to them.
      // X-Frame-Options is left off because it cannot name an allowed origin.
      { source: "/hosted/:path*", headers: BASE_SECURITY_HEADERS },
    ];
  },
};

export default nextConfig;
