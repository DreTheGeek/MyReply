/**
 * Every v1 route, every method, against the credentials that must not get in.
 *
 * The database here throws on any use, so a route that runs a single query
 * before refusing fails the test. That proves two things for every route that
 * exists now and any added later: it sits behind a door, and the door refuses
 * before the route can read anything.
 *
 *   - No key at all: 401.
 *   - A partner key naming a workspace that is not its own: 404, the same
 *     answer as a workspace that does not exist.
 *   - A workspace key on a partner's own endpoints: 401.
 *
 * What happens once a key is let in (that it reads only its own workspace) is
 * proved route by route in partners, webhooks, api-v1, hosted-inbox and
 * channel-compliance.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveApiKey, mockResolvePartner, mockCarriesPartner, mockConsume } = vi.hoisted(() => ({
  mockResolveApiKey: vi.fn(),
  mockResolvePartner: vi.fn(),
  mockCarriesPartner: vi.fn(),
  mockConsume: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`The database was touched before the door refused: prisma.${String(property)}`);
      },
    }
  ),
}));
vi.mock("@/lib/auth", () => ({
  resolveRequestApiKey: mockResolveApiKey,
  resolveRequestPartner: mockResolvePartner,
  requestCarriesPartnerKey: mockCarriesPartner,
  getRequestApiKeyContext: async () => null,
  getCurrentWorkspaceId: async () => null,
  getCurrentUserId: async () => null,
  auth: async () => null,
}));
vi.mock("@/lib/api/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api/rate-limit")>()),
  consumeCredentialRequest: mockConsume,
}));

import { NextRequest } from "next/server";

const ROOT = path.join(__dirname, "..", "app", "api", "v1");
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** The partner's own endpoints, which a workspace key must never reach. */
function isPartnerRoute(route: string): boolean {
  return route === "workspaces" || route.startsWith("workspaces/") || route.startsWith("partner/");
}

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === "route.ts" ? [full] : [];
  });
}

interface Case {
  route: string;
  method: (typeof METHODS)[number];
  file: string;
}

const CASES: Case[] = routes(ROOT)
  .map((file) => ({ file, route: path.relative(ROOT, path.dirname(file)).split(path.sep).join("/") }))
  // The one public document, which holds no data.
  .filter(({ route }) => route !== "openapi.json")
  // Only the methods a route really exports, so every case below is a real call.
  .flatMap(({ file, route }) => {
    const source = readFileSync(file, "utf8");
    return METHODS.filter((method) =>
      new RegExp(`export (?:const|async function) ${method}(?![A-Za-z0-9_])`).test(source)
    ).map((method) => ({ file, route, method }));
  });

async function call(entry: Case): Promise<Response> {
  const routeModule = (await import(entry.file)) as Record<string, unknown>;
  const handler = routeModule[entry.method];
  if (typeof handler !== "function") throw new Error(`${entry.method} /${entry.route} is not a handler`);
  const url = `https://myreply.test/api/v1/${entry.route.replace(/\[(\w+)\]/g, "other_tenants_$1")}`;
  const request = new NextRequest(url, {
    method: entry.method,
    headers: { "content-type": "application/json", "x-workspace-id": "ws_someone_else" },
    ...(entry.method === "GET" ? {} : { body: JSON.stringify({ id: "other_tenants_id", name: "x" }) }),
  });
  const params = Promise.resolve(
    Object.fromEntries([...entry.route.matchAll(/\[(\w+)\]/g)].map((match) => [match[1], `other_tenants_${match[1]}`]))
  );
  return (handler as (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>)(request, {
    params,
  });
}

// Loading every route's module graph once, up front, so no single case pays
// for a cold import inside its own time limit.
beforeAll(async () => {
  for (const file of new Set(CASES.map((entry) => entry.file))) await import(file);
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockConsume.mockResolvedValue({ status: "allowed", remaining: 100 });
});

describe("every v1 route", () => {
  it("is found, so the matrix below is not vacuous", () => {
    expect(new Set(CASES.map((entry) => entry.route)).size).toBeGreaterThan(20);
  });

  it.each(CASES)("$method /$route refuses a request with no key", async (entry) => {
    mockResolveApiKey.mockResolvedValue(null);
    mockResolvePartner.mockResolvedValue(null);
    mockCarriesPartner.mockResolvedValue(false);
    const response = await call(entry);
    expect(response.status).toBe(401);
  });

  it.each(CASES.filter((entry) => !isPartnerRoute(entry.route)))(
    "$method /$route refuses a partner key naming another partner's workspace",
    async (entry) => {
      // The key is a real partner's, but the workspace it names is not theirs,
      // so the workspace-level lookup found nothing.
      mockResolveApiKey.mockResolvedValue(null);
      mockCarriesPartner.mockResolvedValue(true);
      mockResolvePartner.mockResolvedValue({
        partnerId: "partner_b",
        keyId: "pkey_b",
        scopes: [],
        credentialId: "partner:pkey_b",
      });
      const response = await call(entry);
      expect(response.status).toBe(404);
    }
  );

  it.each(CASES.filter((entry) => isPartnerRoute(entry.route)))(
    "$method /$route refuses a workspace key",
    async (entry) => {
      mockCarriesPartner.mockResolvedValue(false);
      mockResolvePartner.mockResolvedValue(null);
      mockResolveApiKey.mockResolvedValue({
        workspaceId: "ws_a",
        role: "ADMIN",
        apiKeyId: "key_a",
        kind: "workspace",
        partnerId: null,
        scopes: [],
        credentialId: "key:key_a",
      });
      const response = await call(entry);
      expect(response.status).toBe(401);
    }
  );
});
