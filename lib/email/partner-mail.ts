import { createTransport } from "nodemailer";
import { prisma } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/oauth/rate-limit";

/**
 * Email sent on a partner's behalf: a connect link or an inbox link, to the
 * partner's own user. It goes out from the partner's sender, never ours, so
 * the person sees only the partner's name. A partner without a sender set up
 * gets a refusal, not a message from our address.
 *
 * The same transport the sign-in links use: SMTP when EMAIL_SERVER is set,
 * otherwise Resend. The partner's sending domain has to be verified with that
 * provider first, which is an owner step.
 */

export const PARTNER_MAIL_PER_MINUTE = 60;

export type PartnerMailResult =
  | { ok: true }
  | { ok: false; reason: "no_sender" | "rate_limited" | "send_failed" };

export interface PartnerMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Characters that mean something in HTML, made inert. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A display name with nothing that could break out of the From header: no
 * line breaks, quotes, backslashes or angle brackets. It is then quoted, so a
 * colon or comma in it can never be read as an address list.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n"\\<>]/g, "").trim();
}

export async function partnerSender(partnerId: string): Promise<string | null> {
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { brandName: true, emailFromName: true, emailFromAddress: true },
  });
  if (!partner?.emailFromAddress) return null;
  const name = headerSafe(partner.emailFromName ?? partner.brandName);
  return name ? `"${name}" <${partner.emailFromAddress}>` : partner.emailFromAddress;
}

export async function sendPartnerMail(
  partnerId: string,
  mail: PartnerMail,
  fetchImpl: typeof fetch = fetch
): Promise<PartnerMailResult> {
  const from = await partnerSender(partnerId);
  if (!from) return { ok: false, reason: "no_sender" };

  const limit = checkRateLimit(`partner-mail:${partnerId}`, PARTNER_MAIL_PER_MINUTE, 60_000);
  if (!limit.allowed) return { ok: false, reason: "rate_limited" };

  try {
    const smtp = process.env.EMAIL_SERVER;
    if (smtp) {
      await createTransport(smtp).sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
      return { ok: true };
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("[partner mail] No mail transport is configured.");
      return { ok: false, reason: "send_failed" };
    }
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!response.ok) {
      console.error("[partner mail] The mail provider refused the message:", response.status);
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true };
  } catch (error) {
    console.error("[partner mail] Sending failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "send_failed" };
  }
}

/** The email that carries a hosted link, in the partner's name. */
export function hostedLinkMail(input: {
  kind: "connect" | "inbox";
  brandName: string;
  url: string;
  expiresAt: string;
  to: string;
}): PartnerMail {
  const brand = input.brandName;
  const until = `${input.expiresAt.slice(0, 16).replace("T", " ")} UTC`;
  const subject = input.kind === "connect" ? `Connect your accounts to ${brand}` : `Your messages on ${brand}`;
  const lead =
    input.kind === "connect"
      ? `Open this link to connect your Instagram or Facebook Page to ${brand}.`
      : `Open this link to read and answer your messages in ${brand}.`;
  const text = `${lead}\n\n${input.url}\n\nThe link works until ${until}. If you did not ask for it, you can ignore this email.`;
  const html = `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(
    input.kind === "connect" ? "Connect your accounts" : "Open your messages"
  )}</a></p><p>The link works until ${escapeHtml(until)}. If you did not ask for it, you can ignore this email.</p>`;
  return { to: input.to, subject, text, html };
}
