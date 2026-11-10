/**
 * The v1 surface: the OpenAPI document matches the routes that exist, a
 * program's message follows automation's rules, and every read is scoped to
 * the caller's workspace.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockReserve,
  mockRelease,
  mockSlot,
  mockOpenChannel,
  mockSend,
  mockResolve,
  mockConsume,
} = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findFirst: vi.fn() },
    contact: { findUnique: vi.fn(), findMany: vi.fn() },
    idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  },
  mockReserve: vi.fn(),
  mockRelease: vi.fn(),
  mockSlot: vi.fn(),
  mockOpenChannel: vi.fn(),
  mockSend: vi.fn(),
  mockResolve: vi.fn(),
  mockConsume: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserve,
  releaseWorkspaceDMReservation: mockRelease,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mockSlot }));
vi.mock("@/lib/channels/registry", () => ({
  openChannel: mockOpenChannel,
  getChannelAdapter: () => ({
    errors: {
      isConfirmedRejection: (error: unknown) => error instanceof Error && error.message === "refused",
      userMessage: () => "This person cannot be messaged right now.",
    },
  }),
}));
vi.mock("@/lib/auth", () => ({
  resolveRequestApiKey: mockResolve,
  requestCarriesPartnerKey: async () => false,
  resolveRequestPartner: async () => null,
}));
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api/rate-limit")>()),
  consumeCredentialRequest: mockConsume,
}));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: vi.fn() }));

import { NextRequest } from "next/server";
import { POST as sendMessage } from "../app/api/v1/messages/route";
import { GET as listContacts } from "../app/api/v1/contacts/route";
import { buildOpenApiDocument, documentedOperations } from "../lib/api/openapi";
import { sendApiMessage } from "../lib/messaging/api-send";

const NOW = new Date("2026-11-11T12:00:00Z");
const ACCOUNT = { id: "acct_1", workspaceId: "ws_1", instagramId: "ig_1", platform: "INSTAGRAM", accessToken: "enc" };
const caller = {
  workspaceId: "ws_1",
  role: "ADMIN",
  apiKeyId: "key_1",
  kind: "workspace",
  partnerId: null,
  scopes: ["messages:send", "contacts:read"],
  credentialId: "key:key_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.instagramAccount.findFirst.mockResolvedValue(ACCOUNT);
  mockPrisma.contact.findUnique.mockResolvedValue({
    lastInboundAt: new Date("2026-11-11T09:00:00Z"),
    optedOutAt: null,
  });
  mockReserve.mockResolvedValue({ allowed: true, periodStart: new Date("2026-11-01") });
  mockSlot.mockResolvedValue({ allowed: true });
  mockSend.mockResolvedValue({ messageId: "mid_1", recipientId: "u_1" });
  mockOpenChannel.mockResolvedValue({ adapter: { messaging: { send: mockSend } }, context: {} });
  mockResolve.mockResolvedValue(caller);
  mockConsume.mockResolvedValue({ status: "allowed", remaining: 100 });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

describe("the OpenAPI document", () => {
  const root = path.join(__dirname, "..", "app", "api", "v1");

  it("documents exactly the routes and methods that exist", () => {
    const actual = new Set<string>();
    for (const file of routeFiles(root)) {
      const route = path
        .relative(root, path.dirname(file))
        .split(path.sep)
        .map((segment) => segment.replace(/^\[(\w+)\]$/, "{$1}"))
        .join("/");
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)\b/g)) {
        actual.add(`${match[1].toLowerCase()} /${route}`);
      }
    }
    const documented = new Set(documentedOperations().map((operation) => `${operation.method} ${operation.path}`));
    expect([...actual].filter((entry) => !documented.has(entry)), "undocumented routes").toEqual([]);
    expect([...documented].filter((entry) => !actual.has(entry)), "documented but missing").toEqual([]);
  });

  it("builds request bodies from the routes' own schemas", () => {
    const document = buildOpenApiDocument("https://api.example.com") as {
      servers: { url: string }[];
      paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } } }>>;
    };
    expect(document.servers[0].url).toBe("https://api.example.com/api/v1");
    const send = document.paths["/messages"].post.requestBody?.content["application/json"].schema;
    expect(Object.keys(send?.properties ?? {})).toEqual(["accountId", "recipientId", "text"]);
    const create = document.paths["/campaigns"].post.requestBody?.content["application/json"].schema;
    expect(create?.properties).toHaveProperty("dmMessage");
    expect(create?.properties).toHaveProperty("captureKinds");
  });

  it("never names this product, so a partner can hand it to its own developers", () => {
    expect(JSON.stringify(buildOpenApiDocument("https://api.example.com")).toLowerCase()).not.toContain("myreply");
  });
});

describe("sending a message through the API", () => {
  it("sends inside the window, as the API, and reports it sent", async () => {
    const result = await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "Your slot is confirmed" }, NOW);
    expect(result).toEqual({ ok: true, status: "sent", messageId: "mid_1", recipientId: "u_1" });
    expect(mockOpenChannel).toHaveBeenCalledWith(ACCOUNT, { source: "api" });
    expect(mockSend.mock.calls[0][1]).toEqual({
      to: { kind: "user", userId: "u_1" },
      content: { kind: "text", text: "Your slot is confirmed" },
    });
    // Automation never sends under the human agent tag.
    expect(mockSend.mock.calls[0][1]).not.toHaveProperty("humanAgent");
  });

  it("only looks for the account inside the caller's workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);
    const result = await sendApiMessage("ws_2", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mockPrisma.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({ id: "acct_1", workspaceId: "ws_2" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses past 24 hours, even though a person could still reply from the inbox", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({ lastInboundAt: new Date("2026-11-09T12:00:00Z"), optedOutAt: null });
    expect(await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW)).toMatchObject({ ok: false, status: 409 });
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("refuses someone with no conversation, and someone who said stop", async () => {
    mockPrisma.contact.findUnique.mockResolvedValueOnce(null);
    expect(await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "stranger", text: "hi" }, NOW)).toMatchObject({ status: 409 });

    mockPrisma.contact.findUnique.mockResolvedValueOnce({ lastInboundAt: NOW, optedOutAt: new Date("2026-11-10") });
    const optedOut = await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW);
    expect(optedOut).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/asked not to be messaged/) });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("gives the budget back on a refusal, and keeps it on an ambiguous answer", async () => {
    mockSend.mockRejectedValueOnce(new Error("refused"));
    expect(await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW)).toMatchObject({ ok: false, status: 422 });
    expect(mockRelease).toHaveBeenCalledTimes(1);

    mockRelease.mockClear();
    mockSend.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW)).toEqual({
      ok: true,
      status: "unconfirmed",
      messageId: null,
      recipientId: "u_1",
    });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("stops at the account's hourly limit and gives the workspace budget back", async () => {
    mockSlot.mockResolvedValue({ allowed: false });
    expect(await sendApiMessage("ws_1", { accountId: "acct_1", recipientId: "u_1", text: "hi" }, NOW)).toMatchObject({ status: 429 });
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("needs an Idempotency-Key at the endpoint", async () => {
    const response = await sendMessage(
      new NextRequest("https://myreply.test/api/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "acct_1", recipientId: "u_1", text: "hi" }),
      }),
      { params: Promise.resolve({}) }
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Idempotency-Key/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("contacts", () => {
  it("are read only from the caller's workspace, with the consent wording", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      {
        id: "c_1",
        instagramAccountId: "acct_1",
        externalId: "u_1",
        username: "bella",
        name: null,
        email: "bella@example.com",
        phone: null,
        optedOutAt: null,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        lastInboundAt: NOW,
        dmCount: 2,
        consents: [{ kind: "EMAIL", value: "bella@example.com", consentText: "We will email you openings.", consentedAt: NOW, automationId: "camp_1" }],
      },
    ]);
    const response = await listContacts(new NextRequest("https://myreply.test/api/v1/contacts?accountId=acct_9"), {
      params: Promise.resolve({}),
    });
    expect(mockPrisma.contact.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1", instagramAccountId: "acct_9" });
    const body = await response.json();
    expect(body.data.contacts[0]).toMatchObject({
      email: "bella@example.com",
      consents: [{ kind: "email", wording: "We will email you openings." }],
    });
  });
});
