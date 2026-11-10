import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { getChannelAdapter, openChannel } from "@/lib/channels/registry";
import { prisma } from "@/lib/db/client";
import { loadPartnerBrand } from "@/lib/partners/brand";
import { loadHostedAccess } from "@/lib/partners/hosted-access";
import { verifyHostedToken } from "@/lib/partners/links";
import { HostedExpired, HostedShell } from "../../hosted-shell";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ account?: string; c?: string; sent?: string; error?: string }>;
};

const PLATFORM_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook" };

const ERROR_COPY: Record<string, string> = {
  window_closed: "This conversation can't be answered any more. They need to message you again first.",
  limit: "Too many messages from this account this hour. Try again shortly.",
  failed: "That message didn't send. Try again.",
  empty: "Write a message first.",
};

interface Conversation {
  id: string;
  personId: string;
  personName: string;
  lastText: string;
  fromMe: boolean;
}

interface Message {
  id: string;
  text: string;
  fromMe: boolean;
  at: string | null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const claims = verifyHostedToken((await params).token, "inbox");
  const brand = claims ? await loadPartnerBrand(claims.p) : null;
  return {
    title: brand ? `Messages | ${brand.brandName}` : "Link expired",
    description: null,
    keywords: null,
    manifest: null,
    appleWebApp: { title: brand?.brandName ?? "" },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/**
 * The partner's hosted inbox: every conversation on the workspace's connected
 * accounts, one thread at a time, and a reply box. Rendered on the server with
 * no client script, so it works inside the partner's frame and on a phone.
 * Replies go through the same rules as the dashboard inbox.
 */
export default async function HostedInboxPage({ params, searchParams }: PageProps): Promise<ReactNode> {
  const { token } = await params;
  const query = await searchParams;
  const access = await loadHostedAccess(token, "inbox", (await headers()).get("host"));
  if (!access) return <HostedExpired />;

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: { connectedAt: "asc" },
  });
  const { brand } = access;

  if (accounts.length === 0) {
    return (
      <HostedShell brand={brand}>
        <h1 className="text-2xl font-semibold">Messages</h1>
        <p className="mt-2 text-sm text-zinc-600">Connect an account first, then its messages show here.</p>
      </HostedShell>
    );
  }

  const account = accounts.find((candidate) => candidate.id === query.account) ?? accounts[0];
  const adapter = getChannelAdapter(account.platform);
  const base = `/hosted/inbox/${encodeURIComponent(token)}`;

  let conversations: Conversation[] = [];
  let thread: Message[] | null = null;
  let loadFailed = false;
  if (adapter.inbox) {
    try {
      const channel = await openChannel(account, { source: "inbox" });
      const raw = await adapter.inbox.conversations(channel.context);
      conversations = raw.map((conversation) => {
        const person = conversation.participants.find((participant) => participant.id !== account.instagramId);
        const last = conversation.messages[0] ?? null;
        return {
          id: conversation.id,
          personId: person?.id ?? "",
          personName: person?.username ?? "Someone",
          lastText: last?.text ?? "",
          fromMe: last?.fromId === account.instagramId,
        };
      });
      if (query.c && conversations.some((conversation) => conversation.id === query.c)) {
        const messages = await adapter.inbox.messages(channel.context, query.c);
        thread = messages
          .map((message) => ({
            id: message.id,
            text: message.text ?? "",
            fromMe: message.fromId === account.instagramId,
            at: message.createdAt,
          }))
          .reverse();
      }
    } catch (error) {
      console.error("[Hosted inbox] Could not load conversations:", error instanceof Error ? error.name : "unknown");
      loadFailed = true;
    }
  }

  const selected = conversations.find((conversation) => conversation.id === query.c) ?? null;

  return (
    <HostedShell brand={brand}>
      <h1 className="text-2xl font-semibold">Messages</h1>

      {accounts.length > 1 ? (
        <nav className="mt-4 flex flex-wrap gap-2 text-sm">
          {accounts.map((candidate) => (
            <a
              key={candidate.id}
              href={`${base}?account=${candidate.id}`}
              className="rounded-full border px-3 py-1"
              style={candidate.id === account.id ? { borderColor: brand.accentColor, color: brand.accentColor } : undefined}
            >
              {PLATFORM_LABEL[candidate.platform] ?? candidate.platform}: @{candidate.username}
            </a>
          ))}
        </nav>
      ) : null}

      {!adapter.inbox ? (
        <p className="mt-6 text-sm text-zinc-600">This account&apos;s messages can&apos;t be shown here.</p>
      ) : loadFailed ? (
        <p className="mt-6 text-sm text-zinc-600">Messages couldn&apos;t be loaded right now. Refresh to try again.</p>
      ) : selected && thread ? (
        <section className="mt-6">
          <a href={`${base}?account=${account.id}`} className="text-sm" style={{ color: brand.primaryColor }}>
            All conversations
          </a>
          <h2 className="mt-3 font-medium">{selected.personName}</h2>
          <ol className="mt-3 space-y-2">
            {thread.map((message) => (
              <li
                key={message.id}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${message.fromMe ? "ml-auto text-white" : "bg-zinc-100"}`}
                style={message.fromMe ? { backgroundColor: brand.accentColor } : undefined}
              >
                {message.text || "(attachment)"}
              </li>
            ))}
          </ol>

          {query.sent ? <p className="mt-4 text-sm text-green-700">Sent.</p> : null}
          {query.error ? (
            <p className="mt-4 text-sm text-red-700">{ERROR_COPY[query.error] ?? ERROR_COPY.failed}</p>
          ) : null}

          <form method="post" action="/api/hosted/inbox/reply" className="mt-4 space-y-2">
            <input type="hidden" name="t" value={token} />
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="conversationId" value={selected.id} />
            <input type="hidden" name="recipientId" value={selected.personId} />
            <textarea
              name="text"
              required
              maxLength={1000}
              rows={3}
              className="w-full rounded-md border border-zinc-300 p-2 text-sm"
              placeholder="Write a reply"
            />
            <button
              type="submit"
              className="rounded-md px-4 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: brand.accentColor }}
            >
              Send
            </button>
          </form>
        </section>
      ) : conversations.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600">No messages yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <a href={`${base}?account=${account.id}&c=${encodeURIComponent(conversation.id)}`} className="block px-4 py-3">
                <span className="block font-medium">{conversation.personName}</span>
                <span className="block truncate text-sm text-zinc-600">
                  {conversation.fromMe ? "You: " : ""}
                  {conversation.lastText}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </HostedShell>
  );
}
