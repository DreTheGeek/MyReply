import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    knowledgeSource: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    knowledgeChunk: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { CrawlError, type CrawlResult } from "../lib/knowledge/crawl";
import {
  MAX_CHUNKS_PER_SOURCE,
  PENDING_GRACE_MINUTES,
  claimDueResyncs,
  failAbandonedIngests,
  runDocumentIngest,
  runManualIngest,
  runWebsiteIngest,
} from "../lib/knowledge/ingest";

interface SourceRow {
  id: string;
  kind: "WEBSITE" | "DOCUMENT" | "MANUAL";
  url: string | null;
  crawlDepth: number;
  title: string;
  status: string;
  errorMessage: string | null;
  lastSyncedAt: Date | null;
  syncEveryHours: number | null;
  updatedAt: Date;
}

let source: SourceRow | null = null;
/** What the transaction was asked to write, so a test can inspect it. */
let written: {
  deleted: boolean;
  chunks: Array<{ ordinal: number; content: string; citation: string | null }>;
  update: Record<string, unknown> | null;
};

function crawlResultOf(
  pages: Array<{ url: string; title: string; text: string }>
): CrawlResult {
  return { pages, skipped: [], hitPageCap: false };
}

/** Enough prose that chunkText produces something real. */
function prose(word: string, times = 90): string {
  return `${word} `.repeat(times).trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  written = { deleted: false, chunks: [], update: null };

  source = {
    id: "src_1",
    kind: "WEBSITE",
    url: "https://shop.test/",
    crawlDepth: 2,
    title: "shop.test",
    status: "PENDING",
    errorMessage: null,
    lastSyncedAt: null,
    syncEveryHours: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  mockPrisma.knowledgeSource.findUnique.mockImplementation(async () => source);

  mockPrisma.knowledgeSource.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      if (source) Object.assign(source, data);
      return source;
    }
  );

  // The transaction is handed already-built promises by Prisma's fluent API, so
  // the mocked builders record their arguments and the transaction just awaits.
  mockPrisma.knowledgeChunk.deleteMany.mockImplementation(async () => {
    written.deleted = true;
    return { count: 0 };
  });
  mockPrisma.knowledgeChunk.createMany.mockImplementation(
    async ({ data }: { data: typeof written.chunks }) => {
      written.chunks = data;
      return { count: data.length };
    }
  );
  mockPrisma.$transaction.mockImplementation(
    async (operations: Array<Promise<unknown>>) => Promise.all(operations)
  );
});

describe("runWebsiteIngest success", () => {
  it("stores chunks that cite the page they came from and marks READY", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf([
        {
          url: "https://shop.test/pricing",
          title: "Pricing",
          text: prose("price"),
        },
      ])
    );

    const outcome = await runWebsiteIngest("src_1", { crawl });

    expect(outcome.status).toBe("READY");
    expect(outcome.chunkCount).toBeGreaterThan(0);
    expect(written.deleted).toBe(true);
    expect(written.chunks[0].citation).toBe(
      "Pricing (https://shop.test/pricing)"
    );
    expect(written.chunks.map((chunk) => chunk.ordinal)).toEqual(
      written.chunks.map((_unused, index) => index)
    );
    expect(source?.status).toBe("READY");
    expect(source?.errorMessage).toBeNull();
  });

  it("passes the stored depth through to the crawler", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf([{ url: "https://shop.test/", title: "Home", text: prose("a") }])
    );

    await runWebsiteIngest("src_1", { crawl });

    expect(crawl).toHaveBeenCalledWith(
      "https://shop.test/",
      expect.objectContaining({ depth: 2 })
    );
  });

  it("adopts the root page title while it is still just the hostname", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf([
        { url: "https://shop.test/", title: "Bea's Bakery", text: prose("a") },
      ])
    );

    await runWebsiteIngest("src_1", { crawl });
    expect(source?.title).toBe("Bea's Bakery");
  });

  it("leaves a title the operator chose alone", async () => {
    if (source) source.title = "My supplier list";
    const crawl = vi.fn(async () =>
      crawlResultOf([
        { url: "https://shop.test/", title: "Bea's Bakery", text: prose("a") },
      ])
    );

    await runWebsiteIngest("src_1", { crawl });
    expect(source?.title).toBe("My supplier list");
  });

  it("caps how many chunks a single crawl can store", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf(
        Array.from({ length: 200 }, (_unused, index) => ({
          url: `https://shop.test/p${index}`,
          title: `P${index}`,
          text: prose("word", 4000),
        }))
      )
    );

    const outcome = await runWebsiteIngest("src_1", { crawl });
    expect(outcome.chunkCount).toBeLessThanOrEqual(MAX_CHUNKS_PER_SOURCE);
    expect(written.chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_SOURCE);
  });

  it("replaces the previous chunks rather than adding to them", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf([{ url: "https://shop.test/", title: "Home", text: prose("a") }])
    );

    await runWebsiteIngest("src_1", { crawl });
    expect(written.deleted).toBe(true);
  });
});

describe("runWebsiteIngest failure", () => {
  it("lands FAILED with the crawler's own message", async () => {
    const crawl = vi.fn(async () => {
      throw new CrawlError("shop.test asks crawlers not to read this address");
    });

    const outcome = await runWebsiteIngest("src_1", { crawl });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toBe(
      "shop.test asks crawlers not to read this address"
    );
    expect(source?.status).toBe("FAILED");
    expect(source?.errorMessage).toBe(
      "shop.test asks crawlers not to read this address"
    );
    // Never left PENDING, which is the whole contract.
    expect(source?.status).not.toBe("PENDING");
  });

  it("lands FAILED for an unexpected error too, never rethrowing", async () => {
    const crawl = vi.fn(async () => {
      throw new TypeError("fetch is not a function");
    });

    const outcome = await runWebsiteIngest("src_1", { crawl });

    expect(outcome.status).toBe("FAILED");
    expect(source?.errorMessage).toBe("fetch is not a function");
  });

  it("gives a message even when the error carries none", async () => {
    const crawl = vi.fn(async () => {
      throw new Error("");
    });

    const outcome = await runWebsiteIngest("src_1", { crawl });
    expect(outcome.errorMessage).toMatch(/unknown reason/);
  });

  it("trims a runaway message so it still fits a table cell", async () => {
    const crawl = vi.fn(async () => {
      throw new CrawlError("x".repeat(5000));
    });

    const outcome = await runWebsiteIngest("src_1", { crawl });
    expect(outcome.errorMessage?.length).toBe(500);
  });

  it("fails a crawl that returned pages with nothing readable in them", async () => {
    const crawl = vi.fn(async () =>
      crawlResultOf([{ url: "https://shop.test/", title: "Home", text: "   " }])
    );

    const outcome = await runWebsiteIngest("src_1", { crawl });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toMatch(/Nothing readable/);
  });

  it("fails a source that has no address to crawl", async () => {
    if (source) source.url = null;
    const outcome = await runWebsiteIngest("src_1", { crawl: vi.fn() });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toMatch(/no address to crawl/);
  });

  it("does nothing when the source was deleted while queued", async () => {
    source = null;
    const crawl = vi.fn();

    const outcome = await runWebsiteIngest("src_gone", { crawl });

    expect(crawl).not.toHaveBeenCalled();
    expect(mockPrisma.knowledgeSource.update).not.toHaveBeenCalled();
    expect(outcome.errorMessage).toBeNull();
  });
});

describe("runDocumentIngest", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("stores chunks citing the filename", async () => {
    const outcome = await runDocumentIngest("src_1", {
      bytes: encode(prose("policy")),
      kind: "txt",
      filename: "returns-policy.txt",
    });

    expect(outcome.status).toBe("READY");
    expect(written.chunks[0].citation).toBe("returns-policy.txt");
  });

  it("lands FAILED with a readable message when the file cannot be read", async () => {
    const outcome = await runDocumentIngest("src_1", {
      bytes: encode("   "),
      kind: "txt",
      filename: "blank.txt",
    });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toMatch(/blank.txt/);
    expect(source?.status).toBe("FAILED");
  });

  it("lands FAILED rather than throwing on a corrupt PDF", async () => {
    const outcome = await runDocumentIngest("src_1", {
      bytes: encode("%PDF-1.4 nope"),
      kind: "pdf",
      filename: "broken.pdf",
    });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toContain("broken.pdf");
  });
});

describe("runManualIngest", () => {
  it("stores exactly one chunk holding the pair", async () => {
    const outcome = await runManualIngest(
      "src_1",
      "Do you ship to Canada?",
      "Yes, in five to seven days."
    );

    expect(outcome.status).toBe("READY");
    expect(written.chunks).toHaveLength(1);
    expect(written.chunks[0].content).toBe(
      "Q: Do you ship to Canada?\nA: Yes, in five to seven days."
    );
    expect(written.chunks[0].citation).toBe("Do you ship to Canada?");
  });

  it("lands FAILED if the write itself fails", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset"));

    const outcome = await runManualIngest("src_1", "Q", "A");

    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toBe("connection reset");
  });
});

describe("failAbandonedIngests", () => {
  it("fails out uploads left PENDING past the grace period", async () => {
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([]);

    const now = new Date("2026-02-01T12:00:00Z");
    const result = await failAbandonedIngests(now);

    expect(result.documents).toBe(3);

    const call = mockPrisma.knowledgeSource.updateMany.mock.calls[0][0] as {
      where: { status: string; updatedAt: { lt: Date } };
      data: { status: string; errorMessage: string };
    };
    expect(call.where.status).toBe("PENDING");
    expect(call.where.updatedAt.lt.getTime()).toBe(
      now.getTime() - PENDING_GRACE_MINUTES * 60_000
    );
    expect(call.data.status).toBe("FAILED");
    expect(call.data.errorMessage).toMatch(/Upload the file again/);
  });

  it("hands stalled crawls back for a retry rather than failing them", async () => {
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([{ id: "src_stuck" }]);

    const result = await failAbandonedIngests(new Date());
    expect(result.websites).toEqual(["src_stuck"]);
  });

  it("touches a stalled crawl so it is not retried on every tick", async () => {
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([{ id: "src_stuck" }]);

    await failAbandonedIngests(new Date());

    expect(mockPrisma.knowledgeSource.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ["src_stuck"] } },
      data: { status: "PENDING" },
    });
  });
});

describe("claimDueResyncs", () => {
  const now = new Date("2026-02-01T12:00:00Z");

  it("claims only sources whose interval has elapsed", async () => {
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([
      {
        id: "src_due",
        syncEveryHours: 24,
        lastSyncedAt: new Date("2026-01-30T12:00:00Z"),
      },
      {
        id: "src_fresh",
        syncEveryHours: 24,
        lastSyncedAt: new Date("2026-02-01T11:00:00Z"),
      },
      { id: "src_never", syncEveryHours: 24, lastSyncedAt: null },
    ]);
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 2 });

    const claimed = await claimDueResyncs(now);

    expect(claimed).toEqual(["src_due", "src_never"]);
  });

  it("moves what it claims to PENDING so a second tick cannot take it", async () => {
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([
      { id: "src_due", syncEveryHours: 1, lastSyncedAt: null },
    ]);
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 1 });

    await claimDueResyncs(now);

    expect(mockPrisma.knowledgeSource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["src_due"] } },
      data: { status: "PENDING", errorMessage: null },
    });
  });

  it("writes nothing when nothing is due", async () => {
    mockPrisma.knowledgeSource.findMany.mockResolvedValue([
      { id: "src_fresh", syncEveryHours: 720, lastSyncedAt: now },
    ]);

    expect(await claimDueResyncs(now)).toEqual([]);
    expect(mockPrisma.knowledgeSource.updateMany).not.toHaveBeenCalled();
  });

  it("honours the batch limit", async () => {
    mockPrisma.knowledgeSource.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_unused, index) => ({
        id: `src_${index}`,
        syncEveryHours: 1,
        lastSyncedAt: null,
      }))
    );
    mockPrisma.knowledgeSource.updateMany.mockResolvedValue({ count: 3 });

    expect(await claimDueResyncs(now, 3)).toHaveLength(3);
  });
});
