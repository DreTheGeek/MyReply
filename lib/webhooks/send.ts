import { SsrfError, assertSafeUrl, type HostResolver } from "@/lib/knowledge/ssrf";

/**
 * One POST to a webhook URL, with the SSRF guard the knowledge crawler uses.
 *
 *   - https only, checked again here and not just when the URL was saved;
 *   - every address the host resolves to must be public, so a URL whose DNS
 *     was pointed at 10.x or the cloud metadata address after it was saved is
 *     refused at send time;
 *   - redirects are never followed. A 3xx is a failed delivery, so a public
 *     host cannot bounce the request somewhere private;
 *   - one ten second deadline, and the response body is never read.
 *
 * The residual DNS rebinding window that lib/knowledge/ssrf.ts records
 * applies here too: the host is resolved, approved, then resolved again by
 * fetch. The blast radius is one signed POST of an event the endpoint's owner
 * was already entitled to.
 */

export const DELIVERY_TIMEOUT_MS = 10_000;

export type PostFetch = (
  input: string,
  init: { method: "POST"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string>; body: string }
) => Promise<Response>;

export type PostResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; reason: string };

/** Refused before anything is sent: not https, or plainly not a public host. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL.";
  }
  if (url.protocol !== "https:") return "Webhook URLs must be https.";
  if (url.username || url.password) return "Remove the username and password from the URL.";
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".internal")) {
    return "Webhook URLs must be on the public internet.";
  }
  return null;
}

export async function postWebhook(
  raw: string,
  headers: Record<string, string>,
  body: string,
  options: { resolve?: HostResolver; fetchImpl?: PostFetch; timeoutMs?: number } = {}
): Promise<PostResult> {
  const problem = webhookUrlProblem(raw);
  if (problem) return { ok: false, status: null, reason: problem };

  let url: URL;
  try {
    url = options.resolve ? await assertSafeUrl(raw, options.resolve) : await assertSafeUrl(raw);
  } catch (error) {
    if (error instanceof SsrfError) {
      return {
        ok: false,
        status: null,
        reason: error.reason === "BLOCKED_ADDRESS" ? "address is private or reserved" : "host could not be found",
      };
    }
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DELIVERY_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as PostFetch);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers,
      body,
    });
    // The body is the receiver's business; drop it without reading.
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, reason: `HTTP ${response.status}, redirects are not followed` };
    }
    return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
  } catch {
    return {
      ok: false,
      status: null,
      reason: controller.signal.aborted ? "timed out after 10 seconds" : "connection failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
