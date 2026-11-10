import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { sendInboxReply } from "@/lib/messaging/inbox-send";
import { checkRateLimit, clientAddress } from "@/lib/oauth/rate-limit";
import { loadHostedAccess } from "@/lib/partners/hosted-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formSchema = z.object({
  t: z.string().min(1).max(6000),
  accountId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(500),
  recipientId: z.string().min(1).max(200),
  text: z.string().trim().max(1000),
});

function plain(status: number, text: string): NextResponse {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * A reply sent from the hosted inbox. The link is the credential, so it is
 * checked exactly as the page checks it, and the form must come from the same
 * host it posts to. The reply goes through the dashboard inbox's own rules,
 * and only to someone who already has a conversation on that account.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limit = checkRateLimit(`hosted-reply:${clientAddress(request)}`, 30, 60_000);
  if (!limit.allowed) return plain(429, "Too many messages. Wait a minute and try again.");

  // A form on someone else's site cannot post here, even holding a link.
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!host || originHost !== host) return plain(403, "This form has to be sent from its own page.");

  const form = await request.formData().catch(() => null);
  const parsed = formSchema.safeParse(form ? Object.fromEntries(form.entries()) : null);
  if (!parsed.success) return plain(400, "That message could not be read.");
  const input = parsed.data;

  const access = await loadHostedAccess(input.t, "inbox", host);
  if (!access) return plain(410, "This link has expired. Go back to the app you came from and open it again.");

  const back = (outcome: Record<string, string>): NextResponse => {
    const url = new URL(`/hosted/inbox/${encodeURIComponent(input.t)}`, request.url);
    url.searchParams.set("account", input.accountId);
    url.searchParams.set("c", input.conversationId);
    for (const [key, value] of Object.entries(outcome)) url.searchParams.set(key, value);
    return NextResponse.redirect(url, 303);
  };

  if (!input.text) return back({ error: "empty" });

  const contact = await prisma.contact.findFirst({
    where: {
      workspaceId: access.workspaceId,
      instagramAccountId: input.accountId,
      externalId: input.recipientId,
    },
    select: { id: true },
  });
  if (!contact) return back({ error: "failed" });

  const result = await sendInboxReply({
    workspaceId: access.workspaceId,
    accountId: input.accountId,
    recipientId: input.recipientId,
    text: input.text,
  });
  if (result.ok) return back({ sent: "1" });
  return back({ error: result.status === 409 ? "window_closed" : result.status === 429 ? "limit" : "failed" });
}
