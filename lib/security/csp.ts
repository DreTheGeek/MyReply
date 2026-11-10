/**
 * The Content-Security-Policy and the other security headers, built in one
 * place for next.config.ts (every route) and proxy.ts (the hosted pages,
 * whose frame-ancestors depend on which partner's link is being opened).
 *
 * Imported by next.config.ts, so it imports nothing: no "@/" alias, no Node
 * modules, just strings.
 *
 * Why the policy is shaped the way it is (script-src 'unsafe-inline', any
 * https image) is written down in next.config.ts.
 */

const isDev = process.env.NODE_ENV === "development";

/**
 * The policy, with `frameAncestors` as its frame-ancestors source list.
 * "'none'" everywhere except a hosted page, which a partner's own site may
 * frame.
 */
export function buildCsp(frameAncestors: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com${isDev ? " 'unsafe-eval'" : ""}`,
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
    `frame-ancestors ${frameAncestors}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Every header except the CSP and X-Frame-Options, which depend on framing. */
export const BASE_SECURITY_HEADERS: { key: string; value: string }[] = [
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
];

/** The full set for a page nobody may frame. */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: buildCsp("'none'") },
  { key: "X-Frame-Options", value: "DENY" },
  ...BASE_SECURITY_HEADERS,
  // Keeps a same-origin window handle out of anything we open, and stops a
  // cross-origin document from measuring this one.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/**
 * A frame-ancestors list from partner origins. Each must be a bare https
 * origin; anything else is dropped, and an empty result means nobody.
 */
export function frameAncestorsFor(origins: readonly string[]): string {
  const safe = origins.filter((origin) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin));
  return safe.length > 0 ? safe.join(" ") : "'none'";
}
