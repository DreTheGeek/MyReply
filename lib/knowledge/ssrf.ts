/**
 * Outbound request guard for the knowledge crawler.
 *
 * Every URL the crawler touches came from a workspace operator, so every fetch
 * here is a server-side request forgery vector. This module is the only place
 * knowledge ingest is allowed to reach the network, and it enforces four things
 * on every hop, not just on the URL that was typed in:
 *
 *   1. The scheme is http or https. No file:, gopher:, data:, blob:.
 *   2. The address it resolves to is publicly routable. Loopback, RFC 1918,
 *      link local (which is where cloud instance metadata lives), unique local,
 *      carrier grade NAT, multicast and reserved space are all refused.
 *   3. Redirects are followed by hand, capped, and re-validated at each hop.
 *      A public host that 302s to http://169.254.169.254/ is the whole reason
 *      checking only the input is not enough.
 *   4. The request has a deadline and the response body has a byte ceiling, so
 *      a slow loris or an endless stream cannot pin a worker.
 *
 * Known residual risk: DNS rebinding. We resolve a hostname, approve every
 * address it returned, then hand the hostname to fetch, which resolves it
 * again. A record with a one second TTL can therefore answer differently on the
 * second lookup. Closing that gap means dialling the approved IP directly with
 * a Host header and our own TLS verification, which undici does not expose
 * through fetch. The window is small and the blast radius is a single GET whose
 * body is only ever turned into text, so it is accepted and recorded here
 * rather than left undocumented.
 */

import { lookup } from "node:dns/promises";

/** Resolves a hostname to every address it answers with. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The subset of fetch this module uses, so tests can substitute their own. */
export type FetchLike = (
  input: string,
  init: {
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
    method: string;
  }
) => Promise<Response>;

export type SsrfReason =
  | "INVALID_URL"
  | "BAD_SCHEME"
  | "EMBEDDED_CREDENTIALS"
  | "BLOCKED_ADDRESS"
  | "UNRESOLVABLE"
  | "TOO_MANY_REDIRECTS"
  | "BAD_REDIRECT"
  | "TIMEOUT"
  | "BODY_TOO_LARGE";

/** A refusal the operator is meant to read, so messages stay plain English. */
export class SsrfError extends Error {
  readonly reason: SsrfReason;

  constructor(reason: SsrfReason, message: string) {
    super(message);
    this.name = "SsrfError";
    this.reason = reason;
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 2_000_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Strict dotted quad only. Anything else, including octal and decimal integer
 * forms such as 0177.0.0.1 or 2130706433, deliberately fails to parse here and
 * is treated as a hostname instead, which sends it through the resolver. The
 * resolver expands those forms to the loopback address they really mean and the
 * address check then refuses them, so the odd notations get caught by DNS
 * rather than by a second, easy to get wrong, parser.
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }

  return octets;
}

/** Returns the 16 bytes of an IPv6 literal, or null when it is not one. */
function parseIpv6(input: string): number[] | null {
  // A zone id (fe80::1%eth0) is never something we want to dial. Refuse to
  // parse it so the caller falls through to the block-by-default branch.
  if (input.includes("%") || input.length === 0) return null;

  let value = input;

  // Rewrite a trailing dotted quad (::ffff:127.0.0.1) into two hextets so the
  // rest of the parser only has to deal with one notation.
  const lastColon = value.lastIndexOf(":");
  if (lastColon >= 0 && value.slice(lastColon + 1).includes(".")) {
    const embedded = parseIpv4(value.slice(lastColon + 1));
    if (!embedded) return null;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColon = value.indexOf("::");
  let head: string[];
  let tail: string[];

  if (doubleColon >= 0) {
    if (value.indexOf("::", doubleColon + 1) >= 0) return null;
    const before = value.slice(0, doubleColon);
    const after = value.slice(doubleColon + 2);
    head = before === "" ? [] : before.split(":");
    tail = after === "" ? [] : after.split(":");
    if (head.length + tail.length > 7) return null;
  } else {
    head = value.split(":");
    tail = [];
    if (head.length !== 8) return null;
  }

  const groups: number[] = [];
  const pushGroup = (group: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    groups.push(parseInt(group, 16));
    return true;
  };

  for (const group of head) {
    if (!pushGroup(group)) return null;
  }
  for (let i = head.length + tail.length; i < 8; i += 1) {
    groups.push(0);
  }
  for (const group of tail) {
    if (!pushGroup(group)) return null;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;

  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // RFC 1918 private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a === 169 && b === 254) return true; // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 private
  if (a === 192 && b === 168) return true; // RFC 1918 private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, and 255.255.255.255

  return false;
}

function isBlockedIpv6(bytes: number[]): boolean {
  const leadingZeros = (count: number): boolean =>
    bytes.slice(0, count).every((byte) => byte === 0);

  // IPv4-mapped ::ffff:0:0/96 carries a real v4 address in the last four bytes.
  if (leadingZeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4(bytes.slice(12));
  }

  // ::, ::1, and the deprecated IPv4-compatible form. None are routable targets.
  if (leadingZeros(12)) return true;

  // NAT64 well known prefix 64:ff9b::/96.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return isBlockedIpv4(bytes.slice(12));
  }

  // 6to4 2002::/16 embeds the v4 address it tunnels to.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isBlockedIpv4(bytes.slice(2, 6));
  }

  if ((bytes[0] & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // site local
  if (bytes[0] === 0xff) return true; // multicast

  return false;
}

/**
 * True when an address must not be dialled. An address this function cannot
 * parse is blocked, so a resolver returning something unexpected fails closed.
 */
export function isBlockedAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");

  const v4 = parseIpv4(trimmed);
  if (v4) return isBlockedIpv4(v4);

  const v6 = parseIpv6(trimmed);
  if (v6) return isBlockedIpv6(v6);

  return true;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Everything that can be checked without touching the network: the scheme, any
 * embedded credentials, and a hostname that is already a private IP literal.
 *
 * Split out so an API route can reject an obviously bad URL with a 400 while
 * the caller is still on the line, instead of accepting it and leaving a FAILED
 * row behind. It is not a substitute for assertSafeUrl, which is what actually
 * runs before every fetch.
 */
export function assertSafeUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("INVALID_URL", `Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(
      "BAD_SCHEME",
      `Only http and https addresses can be fetched, not ${url.protocol.replace(":", "")}`
    );
  }

  // user:pass@host in a crawl target is either a mistake or an attempt to
  // smuggle credentials into an internal service. Neither is worth supporting.
  if (url.username !== "" || url.password !== "") {
    throw new SsrfError(
      "EMBEDDED_CREDENTIALS",
      "Remove the username and password from the address before adding it"
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "") {
    throw new SsrfError("INVALID_URL", `Not a valid URL: ${raw}`);
  }

  const literal = parseIpv4(hostname) ?? parseIpv6(hostname);
  if (literal && isBlockedAddress(hostname)) {
    throw new SsrfError(
      "BLOCKED_ADDRESS",
      `${hostname} is a private or reserved address and cannot be fetched`
    );
  }

  return url;
}

/**
 * Parse, check the scheme, then check every address the host resolves to.
 * Throws SsrfError rather than returning a flag so no caller can forget to look
 * at the result.
 */
export async function assertSafeUrl(
  raw: string,
  resolve: HostResolver = defaultResolve
): Promise<URL> {
  const url = assertSafeUrlShape(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address was already checked by shape, and there is nothing for
  // the resolver to add.
  if (parseIpv4(hostname) ?? parseIpv6(hostname)) return url;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SsrfError("UNRESOLVABLE", `Could not look up ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new SsrfError("UNRESOLVABLE", `Could not look up ${hostname}`);
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(
        "BLOCKED_ADDRESS",
        `${hostname} resolves to the private or reserved address ${address} and cannot be fetched`
      );
    }
  }

  return url;
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  resolve?: HostResolver;
  fetchImpl?: FetchLike;
}

export interface SafeFetchResult {
  /** The URL the body actually came from, after any redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  /** True when the body hit the ceiling and was cut short. */
  truncated: boolean;
}

/**
 * Read at most `maxBytes` from a response. Streams where possible so an
 * oversized body is abandoned rather than buffered in full first.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;

  if (!body || typeof body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes
      ? { bytes: buffer.slice(0, maxBytes), truncated: true }
      : { bytes: buffer, truncated: false };
  }

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const chunk = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
      if (total + chunk.byteLength > maxBytes) {
        parts.push(chunk.slice(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }

      parts.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    // Releasing the lock lets undici tear the socket down when we stopped early.
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return { bytes, truncated };
}

/**
 * Fetch a URL with the full guard applied. Redirects are followed manually so
 * that assertSafeUrl runs again on every hop, which is the check that stops a
 * public host bouncing us into link local space.
 */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const {
    method = "GET",
    accept = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    userAgent = "MyReplyKnowledgeBot/1.0 (+https://myreply.app/bot)",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    resolve = defaultResolve,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
  } = options;

  const controller = new AbortController();
  // One deadline for the whole chain, redirects and body read included, so a
  // server cannot buy unlimited time by trickling bytes or bouncing us around.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = raw;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = await assertSafeUrl(current, resolve);

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: { accept, "user-agent": userAgent },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SsrfError(
            "TIMEOUT",
            `${url.hostname} did not respond within ${Math.round(timeoutMs / 1000)} seconds`
          );
        }
        throw new SsrfError(
          "UNRESOLVABLE",
          `Could not reach ${url.hostname}: ${
            error instanceof Error ? error.message : "connection failed"
          }`
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new SsrfError(
            "BAD_REDIRECT",
            `${url.hostname} sent a redirect with no destination`
          );
        }

        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SsrfError(
            "BAD_REDIRECT",
            `${url.hostname} redirected to an address that could not be read`
          );
        }

        current = next.toString();
        continue;
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new SsrfError(
          "BODY_TOO_LARGE",
          `${url.hostname} returned ${declaredLength} bytes, over the ${maxBytes} byte limit`
        );
      }

      let bytes: Uint8Array;
      let truncated: boolean;
      try {
        const read = await readCappedBody(response, maxBytes);
        bytes = read.bytes;
        truncated = read.truncated;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SsrfError(
            "TIMEOUT",
            `${url.hostname} did not finish sending within ${Math.round(timeoutMs / 1000)} seconds`
          );
        }
        throw new SsrfError(
          "UNRESOLVABLE",
          `Could not read the response from ${url.hostname}: ${
            error instanceof Error ? error.message : "read failed"
          }`
        );
      }

      return {
        finalUrl: url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        bytes,
        truncated,
      };
    }

    throw new SsrfError(
      "TOO_MANY_REDIRECTS",
      `Gave up after ${maxRedirects} redirects starting at ${raw}`
    );
  } finally {
    clearTimeout(timer);
  }
}
