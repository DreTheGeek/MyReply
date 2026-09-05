import type { NextConfig } from "next";

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
 * destructive controls and the public /reports pages both needed.
 *
 * ON img-src AND media-src ALLOWING ANY https ORIGIN. Post thumbnails and reel
 * videos come from Instagram's CDN on signed URLs that expire and are never
 * stored, so there is no fixed host to list. Narrowing this would blank every
 * campaign thumbnail the first time Meta moved a bucket.
 */
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  // 'unsafe-eval' is a development-only concession to fast refresh and the
  // error overlay. It is never sent in production.
  `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com${
    isDev ? " 'unsafe-eval'" : ""
  }`,
  // next/font emits an inline <style> and React sets style attributes, so
  // inline style cannot be removed without breaking first paint. Style is not
  // a script execution sink, which is why this trade is acceptable here.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://va.vercel-scripts.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The modern replacement for X-Frame-Options. Both are sent: the header for
  // anything that still only understands it, this for everything else.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Keeps a same-origin window handle out of anything we open, and stops a
  // cross-origin document from measuring this one.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
