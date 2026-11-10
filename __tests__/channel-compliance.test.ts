/**
 * Meta's privacy callbacks: a person removed the app, or asked for their data
 * to be deleted. Only a request signed with the right app's secret is acted
 * on, and the person's id never lands in the audit log or the request record.
 */

import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    automation: { updateMany: vi.fn() },
    dataDeletionRequest: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    operationalEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { POST as deauthorize } from "../app/api/channels/[platform]/deauthorize/route";
import { POST as dataDeletion } from "../app/api/channels/[platform]/data-deletion/route";
import { hashPlatformUserId } from "../lib/channels/compliance";

const IG_SECRET = "instagram-app-secret";
const FB_SECRET = "facebook-app-secret";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signedRequest(userId: string, secret: string): string {
  const payload = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1 }));
  return `${b64url(createHmac("sha256", secret).update(payload).digest())}.${payload}`;
}

function post(
  handler: typeof deauthorize,
  platform: string,
  body: string
): Promise<Response> {
  return handler(
    new Request(`https://myreply.test/api/channels/${platform}/x`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    { params: Promise.resolve({ platform }) }
  );
}

const form = (value: string): string => new URLSearchParams({ signed_request: value }).toString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSTAGRAM_APP_SECRET", IG_SECRET);
  vi.stubEnv("FACEBOOK_APP_SECRET", FB_SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://myreply.test");
  mockPrisma.instagramAccount.findMany.mockResolvedValue([
    { id: "acct_1", workspaceId: "ws_1" },
    { id: "acct_2", workspaceId: "ws_1" },
    { id: "acct_3", workspaceId: "ws_2" },
  ]);
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 3 });
  mockPrisma.automation.updateMany.mockResolvedValue({ count: 5 });
  mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 3 });
  mockPrisma.dataDeletionRequest.create.mockResolvedValue({ id: "req_1" });
  mockPrisma.dataDeletionRequest.update.mockResolvedValue({});
  mockPrisma.operationalEvent.create.mockResolvedValue({});
});

describe("deauthorize", () => {
  it("erases the token and pauses campaigns on every account the person connected", async () => {
    const response = await post(deauthorize, "instagram", form(signedRequest("igsid_7", IG_SECRET)));
    expect(response.status).toBe(200);

    expect(mockPrisma.instagramAccount.findMany.mock.calls[0][0].where).toEqual({
      platform: "INSTAGRAM",
      // An Instagram professional account logs in as itself, so its own id
      // matches too, which covers rows connected before the granting id was kept.
      OR: [{ authorizedByExternalId: "igsid_7" }, { instagramId: "igsid_7" }],
    });
    expect(mockPrisma.instagramAccount.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["acct_1", "acct_2", "acct_3"] } },
      data: expect.objectContaining({ accessToken: "", webhookSubscribed: false }),
    });
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith({
      where: { instagramAccountId: { in: ["acct_1", "acct_2", "acct_3"] } },
      data: { isActive: false },
    });
    // Nothing is deleted on a deauthorize.
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();

    // One audit row per workspace, and never the person's id.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(2);
    const audits = JSON.stringify(mockPrisma.operationalEvent.create.mock.calls);
    expect(audits).toContain("channel.deauthorized");
    expect(audits).not.toContain("igsid_7");
  });

  it("matches a Facebook person only by who granted the connection", async () => {
    await post(deauthorize, "facebook", form(signedRequest("asid_9", FB_SECRET)));
    expect(mockPrisma.instagramAccount.findMany.mock.calls[0][0].where).toEqual({
      platform: "FACEBOOK",
      OR: [{ authorizedByExternalId: "asid_9" }],
    });
  });

  it("does nothing for a request signed with the wrong secret", async () => {
    // The two apps have separate secrets: a Facebook-signed request is not
    // believed at the Instagram endpoint.
    for (const body of [
      form(signedRequest("igsid_7", "attacker")),
      form(signedRequest("igsid_7", FB_SECRET)),
      form("not-a-signed-request"),
      "",
    ]) {
      const response = await post(deauthorize, "instagram", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    }
    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.updateMany).not.toHaveBeenCalled();
  });

  it("404s a platform with no such callback", async () => {
    expect((await post(deauthorize, "myspace", form("x"))).status).toBe(404);
  });

  it("refuses a body far larger than a signed request", async () => {
    const response = await post(deauthorize, "instagram", form("x".repeat(10_000)));
    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
  });

  it("answers 500 so the platform retries when the database fails", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset by peer at 10.0.0.4"));
    const response = await post(deauthorize, "instagram", form(signedRequest("igsid_7", IG_SECRET)));
    expect(response.status).toBe(500);
    // Never the internal error.
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.4");
  });
});

describe("data deletion", () => {
  it("deletes every account the person connected and returns Meta's status page and code", async () => {
    const response = await post(dataDeletion, "facebook", form(signedRequest("asid_9", FB_SECRET)));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; confirmation_code: string };

    expect(body.confirmation_code).toMatch(/^[A-Z2-9]{16}$/);
    const url = new URL(body.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://myreply.test/data-deletion/status");
    expect(url.searchParams.get("code")).toBe(body.confirmation_code);

    // Recorded first, with the id only as a hash.
    const created = mockPrisma.dataDeletionRequest.create.mock.calls[0][0].data;
    expect(created).toEqual({
      confirmationCode: body.confirmation_code,
      platform: "FACEBOOK",
      userIdHash: hashPlatformUserId("FACEBOOK", "asid_9"),
    });
    expect(JSON.stringify(created)).not.toContain("asid_9");

    expect(mockPrisma.instagramAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["acct_1", "acct_2", "acct_3"] } },
    });
    expect(mockPrisma.dataDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: "req_1" },
      data: { accountsDeleted: 3, completedAt: expect.any(Date) },
    });
    const audits = JSON.stringify(mockPrisma.operationalEvent.create.mock.calls);
    expect(audits).toContain("channel.data_deleted");
    expect(audits).not.toContain("asid_9");
  });

  it("still answers with a code when nothing was held for the person", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);
    const response = await post(dataDeletion, "instagram", form(signedRequest("igsid_0", IG_SECRET)));
    expect(response.status).toBe(200);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.dataDeletionRequest.update.mock.calls[0][0].data.accountsDeleted).toBe(0);
  });

  it("deletes nothing for an unsigned request", async () => {
    const response = await post(dataDeletion, "facebook", form(signedRequest("asid_9", IG_SECRET)));
    expect(response.status).toBe(400);
    expect(mockPrisma.dataDeletionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });
});
