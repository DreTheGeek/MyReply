import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The MCP OAuth server, end to end against an in-memory database.
 *
 * Everything here goes through the real route handlers and the real crypto.
 * Only Prisma, the SSRF-guarded fetch and the NextAuth session are stood in
 * for, because those are the three things a unit test cannot own. The point is
 * that the security properties are asserted on the code that actually runs:
 * PKCE, exact redirect_uri matching, single-use codes, audience binding,
 * membership re-checks and scope narrowing.
 */

interface ClientRow {
  id: string;
  clientId: string;
  registration: "DYNAMIC" | "METADATA_DOCUMENT";
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  scope: string;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  metadataFetchedAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CodeRow {
  id: string;
  hashedCode: string;
  clientRecordId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface TokenRow {
  id: string;
  type: "ACCESS" | "REFRESH";
  hashedToken: string;
  clientRecordId: string;
  authorizationCodeId: string | null;
  userId: string;
  workspaceId: string;
  scope: string;
  resource: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface MemberRow {
  workspaceId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}

interface ApiKeyRow {
  id: string;
  workspaceId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  hashedKey: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

const { store, mockPrisma, mockAuth, mockSafeFetch } = vi.hoisted(() => {
  const store = {
    clients: [] as ClientRow[],
    codes: [] as CodeRow[],
    tokens: [] as TokenRow[],
    members: [] as MemberRow[],
    apiKeys: [] as ApiKeyRow[],
    sequence: 0,
  };

  const nextId = (prefix: string): string => {
    store.sequence += 1;
    return `${prefix}_${store.sequence}`;
  };

  /** Mimics a Prisma `where` on plain scalar fields, null included. */
  const matches = (
    row: Record<string, unknown>,
    where: Record<string, unknown>
  ): boolean =>
    Object.entries(where).every(([field, expected]) =>
      expected === null ? row[field] === null : row[field] === expected
    );

  /** A blank client row, before whatever the caller is writing is laid over it. */
  const blankClient = (): ClientRow => ({
    id: nextId("oc"),
    clientId: "",
    registration: "DYNAMIC",
    clientName: "",
    clientUri: null,
    logoUri: null,
    redirectUris: [],
    scope: "",
    grantTypes: [],
    responseTypes: [],
    tokenEndpointAuthMethod: "none",
    metadataFetchedAt: null,
    disabledAt: null,
    createdAt: new Date("2026-09-04T12:00:00Z"),
    updatedAt: new Date("2026-09-04T12:00:00Z"),
  });

  const mockPrisma = {
    oAuthClient: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = blankClient();
        Object.assign(row, data);
        store.clients.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { clientId: string } }) => {
        const row = store.clients.find((c) => c.clientId === where.clientId);
        return row ? { ...row } : null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { clientId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = store.clients.find((c) => c.clientId === where.clientId);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = blankClient();
        Object.assign(row, create);
        store.clients.push(row);
        return { ...row };
      },
    },

    oAuthAuthorizationCode: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: CodeRow = {
          id: nextId("code"),
          hashedCode: "",
          clientRecordId: "",
          userId: "",
          workspaceId: "",
          redirectUri: "",
          scope: "",
          resource: "",
          codeChallenge: "",
          codeChallengeMethod: "S256",
          expiresAt: new Date(),
          consumedAt: null,
          createdAt: new Date(),
        };
        Object.assign(row, data);
        store.codes.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { hashedCode: string } }) => {
        const row = store.codes.find((c) => c.hashedCode === where.hashedCode);
        return row ? { ...row } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hits = store.codes.filter((row) =>
          matches(row as unknown as Record<string, unknown>, where)
        );
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
    },

    oAuthToken: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const entry of data) {
          const row: TokenRow = {
            id: nextId("tok"),
            type: "ACCESS",
            hashedToken: "",
            clientRecordId: "",
            authorizationCodeId: null,
            userId: "",
            workspaceId: "",
            scope: "",
            resource: "",
            expiresAt: new Date(),
            usedAt: null,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: new Date(),
          };
          Object.assign(row, entry);
          store.tokens.push(row);
        }
        return { count: data.length };
      },
      findUnique: async ({ where }: { where: { hashedToken: string } }) => {
        const row = store.tokens.find((t) => t.hashedToken === where.hashedToken);
        if (!row) return null;
        const client = store.clients.find((c) => c.id === row.clientRecordId);
        return { ...row, client: { disabledAt: client?.disabledAt ?? null } };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = store.tokens.find((t) => t.id === where.id);
        if (row) Object.assign(row, data);
        return row ? { ...row } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hits = store.tokens.filter((row) =>
          matches(row as unknown as Record<string, unknown>, where)
        );
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
    },

    workspaceMember: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        const row = store.members.find(
          (m) => m.workspaceId === workspaceId && m.userId === userId
        );
        return row ? { ...row } : null;
      },
    },

    apiKey: {
      findUnique: async ({ where }: { where: { hashedKey: string } }) => {
        const row = store.apiKeys.find((k) => k.hashedKey === where.hashedKey);
        return row ? { ...row } : null;
      },
      update: async () => ({}),
    },
  };

  return {
    store,
    mockPrisma,
    mockAuth: vi.fn(),
    mockSafeFetch: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/knowledge/ssrf", () => {
  class SsrfError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.name = "SsrfError";
      this.reason = reason;
    }
  }
  return { SsrfError, safeFetch: mockSafeFetch };
});
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: () => "slug123",
}));
vi.mock("@/lib/reports/share", () => ({
  generateReportShareSlug: () => "report123",
  buildReportUrl: (slug: string) => `https://x/reports/${slug}`,
  isReportBranded: () => false,
}));
vi.mock("@/lib/tracking/message", () => ({
  buildTrackedUrl: (slug: string) => `https://x/r/${slug}`,
}));

import { NextRequest } from "next/server";

import { hashApiKey } from "../lib/api-keys";
import { validateAuthorizationRequest } from "../lib/oauth/authorize-request";
import { resolveClient } from "../lib/oauth/clients";
import { signConsentRequest } from "../lib/oauth/consent-request";
import { deriveCodeChallenge } from "../lib/oauth/pkce";
import { resetRateLimits } from "../lib/oauth/rate-limit";
import { narrowRoleForScopes } from "../lib/oauth/scopes";

import { POST as decisionPost } from "../app/api/oauth/decision/route";
import { POST as mcpPost } from "../app/api/mcp/route";
import { POST as registerPost } from "../app/api/oauth/register/route";
import { POST as tokenPost } from "../app/api/oauth/token/route";
import { GET as protectedResourceGet } from "../app/.well-known/oauth-protected-resource/[[...suffix]]/route";
import { GET as authorizationServerGet } from "../app/.well-known/oauth-authorization-server/[[...suffix]]/route";

const ISSUER = "https://myreply.test";
const RESOURCE = `${ISSUER}/api/mcp`;
const METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource/api/mcp`;
const REDIRECT_URI = "https://client.test/oauth/callback";
const USER_ID = "user_1";
const WORKSPACE_ID = "workspace_1";
const OTHER_WORKSPACE_ID = "workspace_2";
const VERIFIER = "verifier".padEnd(64, "x");
const CHALLENGE = deriveCodeChallenge(VERIFIER);

function asUser(userId: string | null): void {
  mockAuth.mockResolvedValue(
    userId ? { user: { id: userId, email: "owner@example.com" } } : null
  );
}

function setRole(role: "OWNER" | "ADMIN" | "MEMBER", workspaceId = WORKSPACE_ID): void {
  const existing = store.members.find(
    (member) => member.workspaceId === workspaceId && member.userId === USER_ID
  );
  if (existing) existing.role = role;
  else store.members.push({ workspaceId, userId: USER_ID, role });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", ISSUER);
  vi.stubEnv("NEXTAUTH_SECRET", "a-test-secret-of-adequate-length");
  resetRateLimits();

  store.clients.length = 0;
  store.codes.length = 0;
  store.tokens.length = 0;
  store.members.length = 0;
  store.apiKeys.length = 0;
  store.sequence = 0;

  asUser(USER_ID);
  setRole("OWNER");
});

/** Register a client the way Claude and ChatGPT do, and return its client_id. */
async function registerClient(
  redirectUris: string[] = [REDIRECT_URI]
): Promise<string> {
  const response = await registerPost(
    new Request(`${ISSUER}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      }),
    })
  );

  expect(response.status).toBe(201);
  const body = await response.json();
  return body.client_id as string;
}

function authorizeParams(
  clientId: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "mcp:read mcp:write",
    resource: RESOURCE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "opaque-state-123",
    ...overrides,
  };
}

/**
 * Walk the consent step exactly as the page does: validate the request, sign
 * what the user was shown, then post the decision.
 */
async function approve(
  clientId: string,
  overrides: Record<string, string> = {},
  workspaceId = WORKSPACE_ID
): Promise<{ code: string; location: string }> {
  const outcome = await validateAuthorizationRequest(
    authorizeParams(clientId, overrides),
    ISSUER
  );
  if (outcome.kind !== "consent") {
    throw new Error(`Expected a consent screen, got ${outcome.kind}`);
  }

  const consent = signConsentRequest({
    clientRecordId: outcome.request.client.id,
    clientId: outcome.request.client.clientId,
    redirectUri: outcome.request.redirectUri,
    scope: outcome.request.scopes.join(" "),
    resource: outcome.request.resource,
    state: outcome.request.state,
    codeChallenge: outcome.request.codeChallenge,
    codeChallengeMethod: "S256",
    userId: USER_ID,
  });

  const response = await decisionPost(
    new Request(`${ISSUER}/api/oauth/decision`, {
      method: "POST",
      body: new URLSearchParams({
        consent,
        decision: "approve",
        workspaceId,
      }),
    })
  );

  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code as string, location };
}

function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return tokenPost(
    new Request(`${ISSUER}/api/oauth/token`, {
      method: "POST",
      body: new URLSearchParams(fields),
    })
  );
}

async function exchange(
  clientId: string,
  code: string,
  overrides: Record<string, string> = {}
): Promise<Response> {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...overrides,
  });
}

/** The whole flow, ending in a usable access token. */
async function connect(
  overrides: Record<string, string> = {}
): Promise<{ clientId: string; accessToken: string; refreshToken: string }> {
  const clientId = await registerClient();
  const { code } = await approve(clientId, overrides);
  const response = await exchange(clientId, code);
  expect(response.status).toBe(200);
  const body = await response.json();
  return {
    clientId,
    accessToken: body.access_token as string,
    refreshToken: body.refresh_token as string,
  };
}

function mcpRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  authorization?: string
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;

  return mcpPost(
    new NextRequest(`${ISSUER}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  );
}

/** Pull the auth-params out of a WWW-Authenticate header. */
function parseChallenge(header: string): {
  scheme: string;
  params: Record<string, string>;
} {
  const scheme = header.slice(0, header.indexOf(" "));
  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z_]+)="([^"]*)"/g;
  let match = pattern.exec(header);
  while (match) {
    params[match[1]] = match[2];
    match = pattern.exec(header);
  }
  return { scheme, params };
}

describe("discovery documents", () => {
  it("serves RFC 9728 protected resource metadata naming this server", async () => {
    const response = await protectedResourceGet(
      new Request(METADATA_URL),
      { params: Promise.resolve({ suffix: ["api", "mcp"] }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
  });

  it("answers the bare well-known path too, since clients ask for both", async () => {
    const response = await protectedResourceGet(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource`),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect((await response.json()).resource).toBe(RESOURCE);
  });

  it("does not describe a resource this server does not host", async () => {
    const response = await protectedResourceGet(
      new Request(`${ISSUER}/.well-known/oauth-protected-resource/api/v1`),
      { params: Promise.resolve({ suffix: ["api", "v1"] }) }
    );

    expect(response.status).toBe(404);
  });

  it("advertises PKCE, no implicit grant, and the iss parameter", async () => {
    const response = await authorizationServerGet(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      { params: Promise.resolve({}) }
    );

    const body = await response.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/api/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/api/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("the 401 that teaches a client where to go", () => {
  it("carries a well-formed WWW-Authenticate naming the metadata document", async () => {
    const response = await mcpRequest("tools/list", {});

    expect(response.status).toBe(401);

    const header = response.headers.get("www-authenticate") ?? "";
    const { scheme, params } = parseChallenge(header);

    expect(scheme).toBe("Bearer");
    expect(params.resource_metadata).toBe(METADATA_URL);
    expect(params.scope).toBe("mcp:read mcp:write");
    // Nothing unquoted, so a strict client parser does not choke on it.
    expect(header.startsWith("Bearer ")).toBe(true);
  });

  it("says invalid_token, not just unauthorized, for a token it does not know", async () => {
    const response = await mcpRequest("tools/list", {}, "Bearer mr_at_nonsense");

    expect(response.status).toBe(401);
    const { params } = parseChallenge(
      response.headers.get("www-authenticate") ?? ""
    );
    expect(params.error).toBe("invalid_token");
    expect(params.resource_metadata).toBe(METADATA_URL);
  });
});

describe("dynamic client registration", () => {
  it("issues a client_id and never a client secret", async () => {
    const response = await registerPost(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: [REDIRECT_URI],
        }),
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_id).toMatch(/^mrc_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("refuses a plain http redirect that is not loopback", async () => {
    const response = await registerPost(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://client.test/cb"] }),
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_client_metadata");
    expect(store.clients).toHaveLength(0);
  });

  it("accepts loopback http, which is how a desktop client listens", async () => {
    const response = await registerPost(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/cb"] }),
      })
    );

    expect(response.status).toBe(201);
  });

  it("refuses a client that wants to authenticate with a secret", async () => {
    const response = await registerPost(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(store.clients).toHaveLength(0);
  });
});

describe("client id metadata documents", () => {
  const DOCUMENT_URL = "https://client.test/.well-known/oauth-client";

  function serveDocument(document: unknown): void {
    mockSafeFetch.mockResolvedValue({
      finalUrl: DOCUMENT_URL,
      status: 200,
      contentType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(document)),
      truncated: false,
    });
  }

  it("registers a client from the document at its own https client_id", async () => {
    serveDocument({
      client_id: DOCUMENT_URL,
      client_name: "Some Agent",
      redirect_uris: ["https://client.test/cb"],
    });

    const client = await resolveClient(DOCUMENT_URL);

    expect(client?.clientName).toBe("Some Agent");
    expect(client?.redirectUris).toEqual(["https://client.test/cb"]);
    // The fetch went through the shared SSRF guard, not a second implementation.
    expect(mockSafeFetch).toHaveBeenCalledWith(
      DOCUMENT_URL,
      expect.objectContaining({ maxRedirects: 2 })
    );
  });

  it("refuses a document that claims somebody else's client_id", async () => {
    serveDocument({
      client_id: "https://other.test/.well-known/oauth-client",
      redirect_uris: ["https://client.test/cb"],
    });

    await expect(resolveClient(DOCUMENT_URL)).rejects.toThrow(/does not match/i);
  });

  it("refuses a document pointing its redirect at a different host", async () => {
    serveDocument({
      client_id: DOCUMENT_URL,
      redirect_uris: ["https://attacker.test/cb"],
    });

    await expect(resolveClient(DOCUMENT_URL)).rejects.toThrow(/different host/i);
  });
});

describe("the authorization request", () => {
  it("requires PKCE", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId, { code_challenge: "" }),
      ISSUER
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;
    const url = new URL(outcome.url);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("error_description")).toMatch(/PKCE/);
  });

  it("refuses the plain challenge method", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId, { code_challenge_method: "plain" }),
      ISSUER
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;
    expect(new URL(outcome.url).searchParams.get("error")).toBe("invalid_request");
  });

  it("matches redirect_uri exactly, so a prefix attack is refused", async () => {
    const clientId = await registerClient();

    for (const attack of [
      `${REDIRECT_URI}.attacker.test`,
      `${REDIRECT_URI}/../evil`,
      `${REDIRECT_URI}extra`,
      "https://attacker.test/oauth/callback",
    ]) {
      const outcome = await validateAuthorizationRequest(
        authorizeParams(clientId, { redirect_uri: attack }),
        ISSUER
      );

      // Rendered on our own page, never redirected to. Redirecting an error to
      // an unregistered address is exactly the open redirect to avoid.
      expect(outcome.kind).toBe("error_page");
    }
  });

  it("refuses an unknown client without redirecting anywhere", async () => {
    const outcome = await validateAuthorizationRequest(
      authorizeParams("mrc_not_a_real_client"),
      ISSUER
    );

    expect(outcome.kind).toBe("error_page");
  });

  it("refuses a resource naming a different MCP server", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId, { resource: "https://elsewhere.test/api/mcp" }),
      ISSUER
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;
    expect(new URL(outcome.url).searchParams.get("error")).toBe("invalid_target");
  });

  it("binds a request with no resource to this server anyway", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      { ...authorizeParams(clientId), resource: undefined } as Record<
        string,
        string | undefined
      >,
      ISSUER
    );

    expect(outcome.kind).toBe("consent");
    if (outcome.kind !== "consent") return;
    expect(outcome.request.resource).toBe(RESOURCE);
  });

  it("refuses a scope this server does not have", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId, { scope: "mcp:read admin:everything" }),
      ISSUER
    );

    expect(outcome.kind).toBe("redirect");
    if (outcome.kind !== "redirect") return;
    expect(new URL(outcome.url).searchParams.get("error")).toBe("invalid_scope");
  });
});

describe("consent", () => {
  it("returns state untouched and names the issuer, per RFC 9207", async () => {
    const clientId = await registerClient();
    const weirdState = "a b&c=d/e+f";
    const { location } = await approve(clientId, { state: weirdState });

    const url = new URL(location);
    expect(url.searchParams.get("state")).toBe(weirdState);
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
  });

  it("sends the user back with access_denied when they deny", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId),
      ISSUER
    );
    if (outcome.kind !== "consent") throw new Error("expected consent");

    const consent = signConsentRequest({
      clientRecordId: outcome.request.client.id,
      clientId: outcome.request.client.clientId,
      redirectUri: outcome.request.redirectUri,
      scope: outcome.request.scopes.join(" "),
      resource: outcome.request.resource,
      state: outcome.request.state,
      codeChallenge: outcome.request.codeChallenge,
      codeChallengeMethod: "S256",
      userId: USER_ID,
    });

    const response = await decisionPost(
      new Request(`${ISSUER}/api/oauth/decision`, {
        method: "POST",
        body: new URLSearchParams({
          consent,
          decision: "deny",
          workspaceId: WORKSPACE_ID,
        }),
      })
    );

    const url = new URL(response.headers.get("location") ?? "");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("opaque-state-123");
    expect(store.codes).toHaveLength(0);
  });

  it("refuses to mint a code for a workspace the user does not belong to", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId),
      ISSUER
    );
    if (outcome.kind !== "consent") throw new Error("expected consent");

    const consent = signConsentRequest({
      clientRecordId: outcome.request.client.id,
      clientId: outcome.request.client.clientId,
      redirectUri: outcome.request.redirectUri,
      scope: outcome.request.scopes.join(" "),
      resource: outcome.request.resource,
      state: null,
      codeChallenge: outcome.request.codeChallenge,
      codeChallengeMethod: "S256",
      userId: USER_ID,
    });

    const response = await decisionPost(
      new Request(`${ISSUER}/api/oauth/decision`, {
        method: "POST",
        body: new URLSearchParams({
          consent,
          decision: "approve",
          workspaceId: OTHER_WORKSPACE_ID,
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(store.codes).toHaveLength(0);
  });

  it("refuses an approval prepared for a different account", async () => {
    const clientId = await registerClient();
    const outcome = await validateAuthorizationRequest(
      authorizeParams(clientId),
      ISSUER
    );
    if (outcome.kind !== "consent") throw new Error("expected consent");

    const consent = signConsentRequest({
      clientRecordId: outcome.request.client.id,
      clientId: outcome.request.client.clientId,
      redirectUri: outcome.request.redirectUri,
      scope: outcome.request.scopes.join(" "),
      resource: outcome.request.resource,
      state: null,
      codeChallenge: outcome.request.codeChallenge,
      codeChallengeMethod: "S256",
      userId: "somebody_else",
    });

    const response = await decisionPost(
      new Request(`${ISSUER}/api/oauth/decision`, {
        method: "POST",
        body: new URLSearchParams({
          consent,
          decision: "approve",
          workspaceId: WORKSPACE_ID,
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(store.codes).toHaveLength(0);
  });
});

describe("the token endpoint", () => {
  it("exchanges a code for an audience-bound pair of tokens", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const response = await exchange(clientId, code);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^mr_at_/);
    expect(body.refresh_token).toMatch(/^mr_rt_/);
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("mcp:read mcp:write");

    // Only hashes are stored. The plaintext exists nowhere in the database.
    const stored = JSON.stringify(store.tokens);
    expect(stored).not.toContain(body.access_token);
    expect(stored).not.toContain(body.refresh_token);
    expect(store.tokens.every((token) => token.resource === RESOURCE)).toBe(true);
  });

  it("rejects a wrong code_verifier and issues nothing", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const response = await exchange(clientId, code, {
      code_verifier: "wrong".padEnd(64, "y"),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
    expect(store.tokens).toHaveLength(0);
  });

  it("rejects a missing code_verifier rather than falling back", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const response = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(/PKCE/);
    expect(store.tokens).toHaveLength(0);
  });

  it("rejects a redirect_uri that only looks like the registered one", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const response = await exchange(clientId, code, {
      redirect_uri: `${REDIRECT_URI}.attacker.test`,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
    expect(store.tokens).toHaveLength(0);
  });

  it("rejects a code presented by a different client", async () => {
    const clientId = await registerClient();
    const otherClientId = await registerClient(["https://client.test/oauth/callback"]);
    const { code } = await approve(clientId);

    const response = await exchange(otherClientId, code);

    expect(response.status).toBe(400);
    expect(store.tokens).toHaveLength(0);
  });

  it("rejects a resource on the token request that names another server", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const response = await exchange(clientId, code, {
      resource: "https://elsewhere.test/api/mcp",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_target");
    expect(store.tokens).toHaveLength(0);
  });

  it("re-checks membership at token issue, not only at consent", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    // Removed from the workspace between approving and redeeming.
    store.members.length = 0;

    const response = await exchange(clientId, code);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
    expect(store.tokens).toHaveLength(0);
  });
});

describe("a code is good exactly once", () => {
  it("refuses a replay and revokes everything the first use issued", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId);

    const first = await exchange(clientId, code);
    expect(first.status).toBe(200);
    const issued = await first.json();
    expect(store.tokens).toHaveLength(2);
    expect(store.tokens.every((token) => token.revokedAt === null)).toBe(true);

    const replay = await exchange(clientId, code);

    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    // No second pair, and the first pair is dead.
    expect(store.tokens).toHaveLength(2);
    expect(store.tokens.every((token) => token.revokedAt !== null)).toBe(true);

    // Proved through the door it actually guards, not just in the table.
    const mcp = await mcpRequest(
      "tools/list",
      {},
      `Bearer ${issued.access_token}`
    );
    expect(mcp.status).toBe(401);
  });
});

describe("refresh tokens rotate, and reuse is detected", () => {
  it("issues a new pair and retires the old refresh token", async () => {
    const { clientId, refreshToken, accessToken } = await connect();

    const response = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.refresh_token).not.toBe(refreshToken);
    expect(body.access_token).not.toBe(accessToken);
    expect(store.tokens).toHaveLength(4);
  });

  it("revokes the whole grant when a spent refresh token comes back", async () => {
    const { clientId, refreshToken } = await connect();

    const rotated = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
    const rotatedBody = await rotated.json();

    const reuse = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });

    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");
    // Including the access token the rotation had just handed out.
    expect(store.tokens.every((token) => token.revokedAt !== null)).toBe(true);

    const mcp = await mcpRequest(
      "tools/list",
      {},
      `Bearer ${rotatedBody.access_token}`
    );
    expect(mcp.status).toBe(401);
  });

  it("will not widen scope on refresh", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId, { scope: "mcp:read" });
    const issued = await (await exchange(clientId, code)).json();

    const response = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: issued.refresh_token,
      scope: "mcp:read mcp:write",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_scope");
  });
});

describe("audience binding at the MCP route", () => {
  it("refuses a token minted for another resource", async () => {
    const { accessToken } = await connect();

    // Same token, re-pointed at somebody else's MCP server. This is the shape
    // of a confused-deputy attack: a token the user approved elsewhere being
    // replayed here.
    for (const token of store.tokens) {
      token.resource = "https://elsewhere.test/api/mcp";
    }

    const response = await mcpRequest("tools/list", {}, `Bearer ${accessToken}`);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("invalid_token");
    expect(body.error_description).toMatch(/different resource/i);
    expect(
      parseChallenge(response.headers.get("www-authenticate") ?? "").params
        .resource_metadata
    ).toBe(METADATA_URL);
  });

  it("accepts a token minted for this resource", async () => {
    const { accessToken } = await connect();

    const response = await mcpRequest("tools/list", {}, `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "create_campaign"
    );
  });

  it("stops accepting a token once the approver leaves the workspace", async () => {
    const { accessToken } = await connect();
    store.members.length = 0;

    const response = await mcpRequest("tools/list", {}, `Bearer ${accessToken}`);

    expect(response.status).toBe(401);
    expect((await response.json()).error_description).toMatch(/no longer a member/i);
  });
});

describe("scope narrows a role and never widens it", () => {
  it("keeps a MEMBER read only even with mcp:write approved", async () => {
    setRole("MEMBER");
    const { accessToken } = await connect();

    const listed = await (
      await mcpRequest("tools/list", {}, `Bearer ${accessToken}`)
    ).json();
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).not.toContain("create_campaign");
    expect(names).not.toContain("update_campaign");
    expect(names).toContain("list_campaigns");

    // And the tool itself still refuses, not just the advertised list.
    const called = await (
      await mcpRequest(
        "tools/call",
        {
          name: "create_campaign",
          arguments: {
            name: "x",
            instagramAccountId: "acct_1",
            keywords: ["a"],
            dmMessage: "hi",
            matchAnyPost: true,
          },
        },
        `Bearer ${accessToken}`
      )
    ).json();

    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toMatch(/read only/i);
  });

  it("keeps an OWNER read only when only mcp:read was approved", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId, { scope: "mcp:read" });
    const issued = await (await exchange(clientId, code)).json();

    const listed = await (
      await mcpRequest("tools/list", {}, `Bearer ${issued.access_token}`)
    ).json();
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).not.toContain("create_campaign");
    expect(names).toContain("list_campaigns");
  });

  it("answers a write tool without mcp:write with a 403 naming the scope", async () => {
    const clientId = await registerClient();
    const { code } = await approve(clientId, { scope: "mcp:read" });
    const issued = await (await exchange(clientId, code)).json();

    const response = await mcpRequest(
      "tools/call",
      { name: "create_campaign", arguments: {} },
      `Bearer ${issued.access_token}`
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("insufficient_scope");

    const { params } = parseChallenge(
      response.headers.get("www-authenticate") ?? ""
    );
    expect(params.error).toBe("insufficient_scope");
    expect(params.scope).toBe("mcp:write");
  });

  it("narrows rather than widens, as a rule", () => {
    expect(narrowRoleForScopes("OWNER", ["mcp:read", "mcp:write"])).toBe("OWNER");
    expect(narrowRoleForScopes("ADMIN", ["mcp:read", "mcp:write"])).toBe("ADMIN");
    expect(narrowRoleForScopes("OWNER", ["mcp:read"])).toBe("MEMBER");
    expect(narrowRoleForScopes("ADMIN", ["mcp:read"])).toBe("MEMBER");
    expect(narrowRoleForScopes("MEMBER", ["mcp:read", "mcp:write"])).toBe("MEMBER");
  });
});

describe("API key access is untouched", () => {
  it("still authenticates an mr_live_ key with no scopes involved", async () => {
    const key = "mr_live_this_is_a_test_key";
    store.apiKeys.push({
      id: "key_1",
      workspaceId: WORKSPACE_ID,
      role: "ADMIN",
      hashedKey: hashApiKey(key),
      revokedAt: null,
      expiresAt: null,
    });

    const response = await mcpRequest("tools/list", {}, `Bearer ${key}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "create_campaign"
    );
  });

  it("challenges a revoked key the same way it challenges no key at all", async () => {
    const key = "mr_live_this_key_was_retired";
    store.apiKeys.push({
      id: "key_2",
      workspaceId: WORKSPACE_ID,
      role: "ADMIN",
      hashedKey: hashApiKey(key),
      revokedAt: new Date("2026-01-01"),
      expiresAt: null,
    });

    const response = await mcpRequest("tools/list", {}, `Bearer ${key}`);

    expect(response.status).toBe(401);
    expect(
      parseChallenge(response.headers.get("www-authenticate") ?? "").params
        .resource_metadata
    ).toBe(METADATA_URL);
  });
});
