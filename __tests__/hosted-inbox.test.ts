/**
 * The partner's hosted inbox: the link is the credential, a reply goes only
 * where the link allows, under the dashboard inbox's own rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSendInbox } = vi.hoisted(() => ({
  mockPrisma: {
    partner: { findFirst: vi.fn(), findUnique: vi.fn() },
    workspace: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
  },
  mockSendInbox: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/messaging/inbox-send", () => ({ sendInboxReply: mockSendInbox }));

import { NextRequest } from "next/server";
import { POST as reply } from "../app/api/hosted/inbox/reply/route";
import { loadHostedAccess } from "../lib/partners/hosted-access";
import { createHostedToken, verifyHostedToken } from "../lib/partners/links";
import { createInboxLink } from "../lib/partners/workspaces";

const LASH_BRAND = {
  id: "partner_lash",
  brandName: "Lash Tech",
  logoUrl: null,
  primaryColor: "#111111",
  accentColor: "#c026d3",
  showPoweredBy: false,
  customDomain: "connect.lashtech.app",
};

function inboxToken(workspaceId = "ws_lash"): string {
  return createHostedToken({ k: "inbox", w: workspaceId, p: "partner_lash", fa: ["https://lashtech.app"] }, 60).token;
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  const body = new URLSearchParams(fields);
  return new NextRequest("https://connect.lashtech.app/api/hosted/inbox/reply", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "connect.lashtech.app",
      origin: "https://connect.lashtech.app",
      ...headers,
    },
    body,
  });
}

function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    t: inboxToken(),
    accountId: "acct_1",
    conversationId: "conv_1",
    recipientId: "u_1",
    text: "See you at 3",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "hosted-inbox-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://app.myreply.test");
  mockPrisma.partner.findFirst.mockResolvedValue(LASH_BRAND);
  mockPrisma.partner.findUnique.mockResolvedValue({ frameOrigins: ["https://lashtech.app"], customDomain: "connect.lashtech.app" });
  mockPrisma.workspace.findFirst.mockImplementation(async ({ where }: { where: { id: string; partnerId: string } }) =>
    where.id === "ws_lash" && where.partnerId === "partner_lash" ? { id: "ws_lash" } : null
  );
  mockPrisma.contact.findFirst.mockResolvedValue({ id: "contact_1" });
  mockSendInbox.mockResolvedValue({ ok: true, receipt: { messageId: "mid_1" } });
});

describe("a hosted inbox link", () => {
  it("is minted only for the partner's own workspace, as an inbox link, on the partner's domain", async () => {
    const result = await createInboxLink("partner_lash", "ws_lash", { expiresInMinutes: 120 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url.startsWith("https://connect.lashtech.app/hosted/inbox/")).toBe(true);
    const token = decodeURIComponent(result.url.split("/hosted/inbox/")[1]);
    expect(verifyHostedToken(token, "inbox")).toMatchObject({ w: "ws_lash", p: "partner_lash" });
    expect(verifyHostedToken(token, "connect")).toBeNull();

    expect(await createInboxLink("partner_lash", "ws_other", {})).toMatchObject({ ok: false, status: 404 });
  });

  it("opens only on our domain or the partner's own", async () => {
    expect(await loadHostedAccess(inboxToken(), "inbox", "connect.lashtech.app")).not.toBeNull();
    expect(await loadHostedAccess(inboxToken(), "inbox", "app.myreply.test")).not.toBeNull();
    expect(await loadHostedAccess(inboxToken(), "inbox", "connect.otherpartner.app")).toBeNull();
  });

  it("stops working once the workspace is no longer the partner's", async () => {
    expect(await loadHostedAccess(inboxToken("ws_other"), "inbox", "connect.lashtech.app")).toBeNull();
  });
});

describe("a reply from the hosted inbox", () => {
  it("sends through the inbox rules, to the workspace the link names, and goes back to the thread", async () => {
    const response = await reply(form(fields()));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname.startsWith("/hosted/inbox/")).toBe(true);
    expect(location.searchParams.get("sent")).toBe("1");
    expect(location.searchParams.get("c")).toBe("conv_1");
    expect(mockSendInbox).toHaveBeenCalledWith({
      workspaceId: "ws_lash",
      accountId: "acct_1",
      recipientId: "u_1",
      text: "See you at 3",
    });
  });

  it("refuses a form posted from another site", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "" }]) {
      const response = await reply(form(fields(), headers));
      expect(response.status).toBe(403);
    }
    expect(mockSendInbox).not.toHaveBeenCalled();
  });

  it("refuses an expired or edited link", async () => {
    const expired = createHostedToken({ k: "inbox", w: "ws_lash", p: "partner_lash", fa: [] }, 1).token;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await reply(form(fields({ t: expired })))).status).toBe(410);
    vi.useRealTimers();

    const connect = createHostedToken({ k: "connect", w: "ws_lash", p: "partner_lash", fa: [] }, 10).token;
    expect((await reply(form(fields({ t: connect })))).status).toBe(410);
    expect(mockSendInbox).not.toHaveBeenCalled();
  });

  it("only replies to someone who already has a conversation on that account", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);
    const response = await reply(form(fields({ recipientId: "a_stranger" })));
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("failed");
    expect(mockPrisma.contact.findFirst.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_lash",
      instagramAccountId: "acct_1",
      externalId: "a_stranger",
    });
    expect(mockSendInbox).not.toHaveBeenCalled();
  });

  it("says plainly when the window has closed", async () => {
    mockSendInbox.mockResolvedValue({ ok: false, status: 409, error: "closed" });
    const response = await reply(form(fields()));
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("window_closed");
  });
});
