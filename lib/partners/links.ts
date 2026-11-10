import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { requireEnv } from "@/lib/env";

/**
 * Signed links to the hosted pages a partner sends its users to: "connect
 * your accounts" and the inbox.
 *
 * The token carries everything the page needs to decide what to show, signed,
 * so it cannot be edited into another workspace: which workspace, which
 * partner, where to send the person afterwards, which origins may frame the
 * page, and when it stops working. The key is derived from NEXTAUTH_SECRET
 * with its own label, so a hosted token can never be replayed as an OAuth
 * state or the other way round.
 */

export const HOSTED_LINK_KINDS = ["connect", "inbox"] as const;
export type HostedLinkKind = (typeof HOSTED_LINK_KINDS)[number];

/** The longest a link may live. A connect link is a one-sitting thing. */
export const MAX_LINK_MINUTES: Record<HostedLinkKind, number> = {
  connect: 60,
  inbox: 12 * 60,
};

const claimsSchema = z.object({
  k: z.enum(HOSTED_LINK_KINDS),
  /** Workspace. */
  w: z.string().min(1).max(100),
  /** Partner. */
  p: z.string().min(1).max(100),
  /** Where the connect page sends the person back to. */
  r: z.string().url().max(2000).optional(),
  /** Platforms the connect page offers, lowercase. */
  pl: z.array(z.string().max(20)).max(10).optional(),
  /** Origins allowed to frame the page, copied from the partner when minted. */
  fa: z.array(z.string().max(200)).max(20),
  /** Expiry, epoch milliseconds. */
  exp: z.number().int().positive(),
  /** Nonce, so two links minted in the same millisecond differ. */
  n: z.string().min(8).max(40),
});

export type HostedLinkClaims = z.infer<typeof claimsSchema>;

function signingKey(): Buffer {
  return createHash("sha256")
    .update(`hosted-link:v1:${requireEnv("NEXTAUTH_SECRET")}`)
    .digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function createHostedToken(
  claims: Omit<HostedLinkClaims, "n" | "exp">,
  ttlMinutes: number
): { token: string; expiresAt: Date } {
  const minutes = Math.min(Math.max(1, Math.floor(ttlMinutes)), MAX_LINK_MINUTES[claims.k]);
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const full: HostedLinkClaims = {
    ...claims,
    exp: expiresAt.getTime(),
    n: randomBytes(9).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

/**
 * The claims of a valid, unexpired token of the expected kind, or null. Never
 * throws: a mangled link is a "this link has expired" page, not an error.
 */
export function verifyHostedToken(
  token: string | null | undefined,
  kind: HostedLinkKind,
  now: number = Date.now()
): HostedLinkClaims | null {
  if (!token || token.length > 6000) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = claimsSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (parsed.data.k !== kind) return null;
  if (parsed.data.exp <= now) return null;
  return parsed.data;
}

/**
 * An https origin exactly as a browser sends it in Origin, or null. Paths,
 * queries, credentials and wildcards are refused, so an allowlist entry means
 * one origin and nothing more.
 */
export function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hostname.includes("*")) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return url.origin;
}

/** True when `returnUrl` is https and sits on one of the allowed origins. */
export function isAllowedReturnUrl(returnUrl: string, allowedOrigins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return allowedOrigins.includes(url.origin);
}

/** The hostname a hosted link is served from: the partner's own, or ours. */
export function hostedBaseUrl(customDomain: string | null, fallbackBaseUrl: string): string {
  return customDomain ? `https://${customDomain}` : fallbackBaseUrl.replace(/\/$/, "");
}

/** Appends the connect outcome to the partner's return URL. */
export function returnUrlWithOutcome(
  returnUrl: string,
  outcome: { status: string; platform: string; workspaceId: string; connected?: number }
): string {
  const url = new URL(returnUrl);
  url.searchParams.set("connect_status", outcome.status);
  url.searchParams.set("platform", outcome.platform);
  url.searchParams.set("workspace_id", outcome.workspaceId);
  if (outcome.connected !== undefined) url.searchParams.set("connected", String(outcome.connected));
  return url.toString();
}
