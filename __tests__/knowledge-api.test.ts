import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext, mockCanManage, mockAfter, mockIngest } =
  vi.hoisted(() => ({
    mockPrisma: {
      knowledgeSource: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      knowledgeChunk: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      // Read by the plan gate. The knowledge base is a Pro feature, so these
      // tests, which are about the route's behaviour rather than about billing,
      // run as a Pro workspace. The refusal on Free has its own test below.
      workspace: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    mockContext: vi.fn(),
    mockCanManage: vi.fn(),
    mockAfter: vi.fn(),
    mockIngest: {
      runWebsiteIngest: vi.fn(),
      runDocumentIngest: vi.fn(),
      runManualIngest: vi.fn(),
      claimDueResyncs: vi.fn(),
      failAbandonedIngests: vi.fn(),
    },
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// canManageWorkspace goes through a mock so one test can loosen the write gate
// and prove the workspace scoping holds on its own rather than by coincidence.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string): boolean => mockCanManage(role),
}));

// `after` is Next's post-response hook. Captured rather than executed, so a
// test can assert the request returned before ingest ran, then run it by hand.
vi.mock("next/server", async () => {
  const actual =
    await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mockAfter };
});

vi.mock("@/lib/knowledge/ingest", () => mockIngest);

import { NextRequest } from "next/server";

import { DELETE, GET, POST } from "../app/api/knowledge/route";
import { POST as RESYNC } from "../app/api/knowledge/[id]/resync/route";
import { GET as CRON } from "../app/api/cron/ingest-knowledge/route";

const URL_BASE = "https://myreply.test/api/knowledge";
const OWN_WORKSPACE = "workspace_ours";
const OTHER_WORKSPACE = "workspace_theirs";

interface StoredSource {
  id: string;
  workspaceId: string;
  kind: "WEBSITE" | "DOCUMENT" | "MANUAL";
  title: string;
  url: string | null;
  crawlDepth: number;
  status: "PENDING" | "READY" | "FAILED";
  errorMessage: string | null;
  lastSyncedAt: Date | null;
  syncEveryHours: number | null;
  createdAt: Date;
  chunkCount: number;
}

let store: StoredSource[] = [];
let nextId = 0;

function seed(partial: Partial<StoredSource> & { workspaceId: string }): StoredSource {
  nextId += 1;
  const row: StoredSource = {
    id: `src_${nextId}`,
    kind: "WEBSITE",
    title: "Example",
    url: "https://example.com/",
    crawlDepth: 1,
    status: "READY",
    errorMessage: null,
    lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
    syncEveryHours: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    chunkCount: 3,
    ...partial,
  };
  store.push(row);
  return row;
}

function jsonPost(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function del(body: unknown): Promise<Response> {
  return DELETE(
    new NextRequest(URL_BASE, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function resync(id: string): Promise<Response> {
  return RESYNC(new Request(`${URL_BASE}/${id}/resync`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  nextId = 0;
  delete process.env.CRON_SECRET;

  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: OWN_WORKSPACE,
    workspace: { id: OWN_WORKSPACE },
    role: "ADMIN",
  });
  mockCanManage.mockImplementation(
    (role: string) => role === "OWNER" || role === "ADMIN"
  );
  mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" });
  // Default: hold the callback so a test can assert the response landed first.
  mockAfter.mockImplementation(() => undefined);

  mockPrisma.knowledgeSource.findMany.mockImplementation(
    async ({ where }: { where: { workspaceId?: string } }) =>
      store
        .filter((row) =>
          where.workspaceId ? row.workspaceId === where.workspaceId : true
        )
        .map((row) => ({ ...row, _count: { chunks: row.chunkCount } }))
  );

  mockPrisma.knowledgeSource.findFirst.mockImplementation(
    async ({ where }: { where: { id: string; workspaceId: string } }) =>
      store.find(
        (row) => row.id === where.id && row.workspaceId === where.workspaceId
      ) ?? null
  );

  mockPrisma.knowledgeSource.create.mockImplementation(
    async ({ data }: { data: Partial<StoredSource> & { workspaceId: string } }) =>
      seed({ ...data, chunkCount: 0, workspaceId: data.workspaceId })
  );

  mockPrisma.knowledgeSource.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<StoredSource> }) => {
      const row = store.find((entry) => entry.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    }
  );

  mockPrisma.knowledgeSource.deleteMany.mockImplementation(
    async ({ where }: { where: { id: string; workspaceId: string } }) => {
      const before = store.length;
      store = store.filter(
        (row) =>
          !(row.id === where.id && row.workspaceId === where.workspaceId)
      );
      return { count: before - store.length };
    }
  );

  mockIngest.runManualIngest.mockResolvedValue({
    status: "READY",
    chunkCount: 1,
    errorMessage: null,
  });
  mockIngest.runWebsiteIngest.mockResolvedValue({
    status: "READY",
    chunkCount: 5,
    errorMessage: null,
  });
  mockIngest.failAbandonedIngests.mockResolvedValue({
    websites: [],
    documents: 0,
  });
  mockIngest.claimDueResyncs.mockResolvedValue([]);
});

describe("GET /api/knowledge", () => {
  it("rejects a caller with no workspace", async () => {
    mockContext.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns only this workspace's sources, with chunk counts", async () => {
    seed({ workspaceId: OWN_WORKSPACE, title: "Ours", chunkCount: 7 });
    seed({ workspaceId: OTHER_WORKSPACE, title: "Theirs", chunkCount: 9 });

    const response = await GET();
    const payload = await response.json();

    expect(payload.data.sources).toHaveLength(1);
    expect(payload.data.sources[0].title).toBe("Ours");
    expect(payload.data.sources[0].chunkCount).toBe(7);
  });

  it("lets a member read, since only writes are gated", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });
    seed({ workspaceId: OWN_WORKSPACE });

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).data.currentUserRole).toBe("MEMBER");
  });

  it("reports the failure message on a FAILED source", async () => {
    seed({
      workspaceId: OWN_WORKSPACE,
      status: "FAILED",
      errorMessage: "shop.test returned HTTP 500",
    });

    const payload = await (await GET()).json();
    expect(payload.data.sources[0].errorMessage).toBe(
      "shop.test returned HTTP 500"
    );
  });
});

describe("the plan gate", () => {
  it("refuses a Free workspace with 402, not 403", async () => {
    // 402 rather than 403 on purpose: a client needs to tell "your plan does
    // not include this", which an upgrade fixes, from "you are not allowed",
    // which it does not.
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });

    const response = await jsonPost({
      kind: "MANUAL",
      question: "Do you ship?",
      answer: "Yes, within a week.",
    });

    expect(response.status).toBe(402);
    const payload = await response.json();
    expect(payload.feature).toBe("knowledge_base");
    expect(payload.requiredPlan).toBe("PRO");
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("lets a Free workspace still read what it already has", async () => {
    // Nothing is taken away by a downgrade. Sources stay readable, they just
    // cannot be added to.
    mockPrisma.workspace.findUnique.mockResolvedValue({ plan: "FREE" });
    seed({ workspaceId: OWN_WORKSPACE, status: "READY" });

    const response = await GET();
    expect(response.status).toBe(200);
  });
});

describe("POST /api/knowledge", () => {
  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await jsonPost({ kind: "MANUAL", question: "a", answer: "b" })).status).toBe(
      401
    );
  });

  it("refuses a member", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });

    const response = await jsonPost({
      kind: "WEBSITE",
      url: "https://example.com",
      crawlDepth: 1,
    });

    expect(response.status).toBe(403);
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("creates a website source as PENDING and does not crawl in the request", async () => {
    const response = await jsonPost({
      kind: "WEBSITE",
      url: "https://example.com/docs",
      crawlDepth: 3,
      syncEveryHours: 24,
    });

    expect(response.status).toBe(201);
    expect((await response.json()).data.status).toBe("PENDING");

    // The crawl was handed to `after`, not awaited inline.
    expect(mockIngest.runWebsiteIngest).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);

    const created = store[0];
    expect(created.workspaceId).toBe(OWN_WORKSPACE);
    expect(created.status).toBe("PENDING");
    expect(created.crawlDepth).toBe(3);
    expect(created.syncEveryHours).toBe(24);
  });

  it("runs the handed-off crawl when the response is done", async () => {
    const deferred: Array<() => Promise<void>> = [];
    mockAfter.mockImplementation((callback: () => Promise<void>) => {
      deferred.push(callback);
    });

    await jsonPost({ kind: "WEBSITE", url: "https://example.com", crawlDepth: 1 });
    await deferred[0]();

    expect(mockIngest.runWebsiteIngest).toHaveBeenCalledWith(store[0].id);
  });

  it("refuses a private address before creating anything", async () => {
    const response = await jsonPost({
      kind: "WEBSITE",
      url: "http://169.254.169.254/latest/meta-data/",
      crawlDepth: 1,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/private or reserved/);
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("refuses a non-http scheme", async () => {
    const response = await jsonPost({
      kind: "WEBSITE",
      url: "file:///etc/passwd",
      crawlDepth: 1,
    });
    expect(response.status).toBe(400);
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("refuses a crawl depth outside 1 to 3", async () => {
    expect(
      (await jsonPost({ kind: "WEBSITE", url: "https://a.test", crawlDepth: 0 }))
        .status
    ).toBe(400);
    expect(
      (await jsonPost({ kind: "WEBSITE", url: "https://a.test", crawlDepth: 9 }))
        .status
    ).toBe(400);
  });

  it("stores a question and answer straight away", async () => {
    const response = await jsonPost({
      kind: "MANUAL",
      question: "Do you ship to Canada?",
      answer: "Yes, in five to seven days.",
    });

    expect(response.status).toBe(201);
    expect(mockIngest.runManualIngest).toHaveBeenCalledWith(
      store[0].id,
      "Do you ship to Canada?",
      "Yes, in five to seven days."
    );
    expect(store[0].title).toBe("Do you ship to Canada?");
  });

  it("refuses a question with no answer", async () => {
    expect(
      (await jsonPost({ kind: "MANUAL", question: "Why?", answer: "  " })).status
    ).toBe(400);
  });

  it("refuses an unknown kind", async () => {
    expect((await jsonPost({ kind: "MAGIC", url: "https://a.test" })).status).toBe(
      400
    );
  });
});

describe("POST /api/knowledge with a file", () => {
  function upload(filename: string, body: string, type = ""): Promise<Response> {
    const form = new FormData();
    form.append("file", new File([body], filename, { type }));
    return POST(new NextRequest(URL_BASE, { method: "POST", body: form }));
  }

  it("accepts a text file and defers the parse", async () => {
    const response = await upload("hours.txt", "We open at nine.", "text/plain");

    expect(response.status).toBe(201);
    expect((await response.json()).data.status).toBe("PENDING");
    expect(store[0].kind).toBe("DOCUMENT");
    expect(store[0].title).toBe("hours.txt");
    expect(mockIngest.runDocumentIngest).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("hands the bytes to the deferred parse, since nothing else keeps them", async () => {
    const deferred: Array<() => Promise<void>> = [];
    mockAfter.mockImplementation((callback: () => Promise<void>) => {
      deferred.push(callback);
    });

    await upload("prices.csv", "Item,Price\nMug,12\n", "text/csv");
    await deferred[0]();

    const [sourceId, file] = mockIngest.runDocumentIngest.mock.calls[0] as [
      string,
      { bytes: Uint8Array; kind: string; filename: string },
    ];
    expect(sourceId).toBe(store[0].id);
    expect(file.kind).toBe("csv");
    expect(file.filename).toBe("prices.csv");
    expect(new TextDecoder().decode(file.bytes)).toContain("Mug,12");
  });

  it("refuses a file type it cannot read", async () => {
    const response = await upload("archive.zip", "PK", "application/zip");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/\.pdf/);
    expect(mockPrisma.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    const response = await upload("blank.txt", "", "text/plain");
    expect(response.status).toBe(400);
  });

  it("refuses an upload from a member", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });
    expect((await upload("hours.txt", "x", "text/plain")).status).toBe(403);
  });
});

describe("DELETE /api/knowledge", () => {
  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await del({ id: "src_1" })).status).toBe(401);
  });

  it("refuses a member", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });
    const source = seed({ workspaceId: OWN_WORKSPACE });
    expect((await del({ id: source.id })).status).toBe(403);
    expect(store).toHaveLength(1);
  });

  it("removes a source in this workspace", async () => {
    const source = seed({ workspaceId: OWN_WORKSPACE });
    expect((await del({ id: source.id })).status).toBe(200);
    expect(store).toHaveLength(0);
  });

  it("answers 404 for a source in another workspace, and leaves it alone", async () => {
    const theirs = seed({ workspaceId: OTHER_WORKSPACE });

    const response = await del({ id: theirs.id });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Source not found");
    expect(store).toHaveLength(1);
  });

  it("still refuses another workspace's id when the role gate is loosened", async () => {
    // Proves the scoping is in the query, not a side effect of the role check.
    mockCanManage.mockReturnValue(true);
    const theirs = seed({ workspaceId: OTHER_WORKSPACE });

    expect((await del({ id: theirs.id })).status).toBe(404);
    expect(store).toHaveLength(1);
  });

  it("requires an id", async () => {
    expect((await del({})).status).toBe(400);
  });
});

describe("POST /api/knowledge/[id]/resync", () => {
  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await resync("src_1")).status).toBe(401);
  });

  it("refuses a member", async () => {
    mockContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: OWN_WORKSPACE,
      workspace: { id: OWN_WORKSPACE },
      role: "MEMBER",
    });
    const source = seed({ workspaceId: OWN_WORKSPACE });
    expect((await resync(source.id)).status).toBe(403);
  });

  it("moves the source to PENDING and defers the crawl", async () => {
    const source = seed({
      workspaceId: OWN_WORKSPACE,
      status: "FAILED",
      errorMessage: "was broken",
    });

    const response = await resync(source.id);

    expect(response.status).toBe(200);
    expect(store[0].status).toBe("PENDING");
    expect(store[0].errorMessage).toBeNull();
    expect(mockIngest.runWebsiteIngest).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for another workspace's source", async () => {
    const theirs = seed({ workspaceId: OTHER_WORKSPACE });
    const response = await resync(theirs.id);

    expect(response.status).toBe(404);
    expect(store[0].status).toBe("READY");
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that does not exist at all", async () => {
    expect((await resync("src_nope")).status).toBe(404);
  });

  it("explains why a Q and A cannot be re-synced", async () => {
    const source = seed({ workspaceId: OWN_WORKSPACE, kind: "MANUAL", url: null });
    const response = await resync(source.id);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/nothing to re-sync/);
  });

  it("explains why an uploaded file must be uploaded again", async () => {
    const source = seed({
      workspaceId: OWN_WORKSPACE,
      kind: "DOCUMENT",
      url: "policy.pdf",
    });
    const response = await resync(source.id);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Upload the file again/);
  });
});

describe("GET /api/cron/ingest-knowledge", () => {
  function tick(token?: string): Promise<Response> {
    return CRON(
      new NextRequest("https://myreply.test/api/cron/ingest-knowledge", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    );
  }

  it("refuses a request with no token", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await tick()).status).toBe(401);
  });

  it("refuses a wrong token", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await tick("nope")).status).toBe(401);
  });

  it("retries stalled crawls and fails out abandoned uploads", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockIngest.failAbandonedIngests.mockResolvedValue({
      websites: ["src_stuck"],
      documents: 2,
    });

    const response = await tick("s3cret");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.abandonedUploadsFailed).toBe(2);
    expect(mockIngest.runWebsiteIngest).toHaveBeenCalledWith("src_stuck");
  });

  it("runs sources whose scheduled refresh came due", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockIngest.claimDueResyncs.mockResolvedValue(["src_due"]);

    await tick("s3cret");
    expect(mockIngest.runWebsiteIngest).toHaveBeenCalledWith("src_due");
  });

  it("records FAILED when an ingest throws instead of reporting", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockIngest.failAbandonedIngests.mockResolvedValue({
      websites: ["src_boom"],
      documents: 0,
    });
    mockIngest.runWebsiteIngest.mockRejectedValue(new Error("database is down"));

    const payload = await (await tick("s3cret")).json();

    expect(payload.data.results[0].status).toBe("FAILED");
    expect(mockPrisma.knowledgeSource.update).toHaveBeenCalledWith({
      where: { id: "src_boom" },
      data: { status: "FAILED", errorMessage: "database is down" },
    });
  });
});
