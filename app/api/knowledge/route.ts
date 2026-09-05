import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { checkPlanFeature } from "@/lib/plan-gate";
import { prisma } from "@/lib/db/client";
import {
  MAX_CRAWL_DEPTH,
  MIN_CRAWL_DEPTH,
} from "@/lib/knowledge/crawl";
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  MAX_DOCUMENT_BYTES,
  detectDocumentKind,
} from "@/lib/knowledge/documents";
import {
  runDocumentIngest,
  runManualIngest,
  runWebsiteIngest,
} from "@/lib/knowledge/ingest";
import { SsrfError, assertSafeUrlShape } from "@/lib/knowledge/ssrf";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// dns, unpdf and mammoth all need Node built-ins, so this route cannot run on
// the edge runtime.
export const runtime = "nodejs";

const websiteSchema = z.object({
  kind: z.literal("WEBSITE"),
  url: z.string().trim().min(1).max(2048),
  title: z.string().trim().min(1).max(120).optional(),
  crawlDepth: z
    .number()
    .int()
    .min(MIN_CRAWL_DEPTH)
    .max(MAX_CRAWL_DEPTH)
    .default(1),
  // Null means never refresh on its own, which is the schema's own default.
  syncEveryHours: z.number().int().min(1).max(720).nullable().optional(),
});

const manualSchema = z.object({
  kind: z.literal("MANUAL"),
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(10_000),
});

const createSchema = z.discriminatedUnion("kind", [websiteSchema, manualSchema]);

const deleteSchema = z.object({ id: z.string().min(1) });

/** One row as the list endpoint reports it. */
export interface KnowledgeSourceRow {
  id: string;
  kind: "WEBSITE" | "DOCUMENT" | "MANUAL";
  title: string;
  url: string | null;
  crawlDepth: number;
  status: "PENDING" | "READY" | "FAILED";
  errorMessage: string | null;
  lastSyncedAt: string | null;
  syncEveryHours: number | null;
  createdAt: string;
  chunkCount: number;
}

/**
 * List this workspace's sources with their chunk counts.
 *
 * Open to any member, matching /api/workspace/api-keys: a member can see what
 * the assistant is answering from, while every write below stays behind
 * canManageWorkspace.
 */
export async function GET(): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const sources = await prisma.knowledgeSource.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      title: true,
      url: true,
      crawlDepth: true,
      status: true,
      errorMessage: true,
      lastSyncedAt: true,
      syncEveryHours: true,
      createdAt: true,
      _count: { select: { chunks: true } },
    },
  });

  const rows: KnowledgeSourceRow[] = sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    title: source.title,
    url: source.url,
    crawlDepth: source.crawlDepth,
    status: source.status,
    errorMessage: source.errorMessage,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    syncEveryHours: source.syncEveryHours,
    createdAt: source.createdAt.toISOString(),
    chunkCount: source._count.chunks,
  }));

  return NextResponse.json({
    success: true,
    data: { sources: rows, currentUserRole: context.role },
  });
}

/**
 * Add a source and start ingesting it.
 *
 * A crawl takes minutes, so the row is created PENDING and the work is handed
 * to `after()`, which runs once this response has been flushed. The cron at
 * /api/cron/ingest-knowledge is the backstop: anything still PENDING after the
 * grace period is either retried or failed out with a message, so no row can
 * sit PENDING forever.
 *
 * A file upload arrives as multipart. Its bytes only exist inside this request,
 * so they are read here and handed to the detached ingest by value.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only owners and admins can add knowledge sources",
      },
      { status: 403 }
    );
  }

  // The knowledge base is a paid feature and was reachable on every plan.
  const planGate = await checkPlanFeature(context.workspaceId, "knowledge_base");
  if (planGate) return planGate;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return createDocumentSource(request, context.workspaceId);
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Send a website address with a depth of 1 to 3, or a question and an answer",
      },
      { status: 400 }
    );
  }

  if (parsed.data.kind === "MANUAL") {
    const source = await prisma.knowledgeSource.create({
      data: {
        workspaceId: context.workspaceId,
        kind: "MANUAL",
        title: parsed.data.question.slice(0, 120),
        status: "PENDING",
      },
      select: { id: true },
    });

    // A pair is one chunk and no network call, so it is finished here rather
    // than handed off. It still goes through runManualIngest so a database
    // failure lands as FAILED with a message like every other kind.
    const outcome = await runManualIngest(
      source.id,
      parsed.data.question,
      parsed.data.answer
    );

    return NextResponse.json(
      { success: true, data: { id: source.id, status: outcome.status } },
      { status: 201 }
    );
  }

  let normalizedUrl: URL;
  try {
    normalizedUrl = assertSafeUrlShape(parsed.data.url);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof SsrfError
            ? error.message
            : "That address cannot be crawled",
      },
      { status: 400 }
    );
  }

  const source = await prisma.knowledgeSource.create({
    data: {
      workspaceId: context.workspaceId,
      kind: "WEBSITE",
      // The hostname is a placeholder. The first successful crawl replaces it
      // with the root page's real title.
      title: parsed.data.title ?? normalizedUrl.hostname,
      url: normalizedUrl.toString(),
      crawlDepth: parsed.data.crawlDepth,
      syncEveryHours: parsed.data.syncEveryHours ?? null,
      status: "PENDING",
    },
    select: { id: true },
  });

  after(async () => {
    await runWebsiteIngest(source.id);
  });

  return NextResponse.json(
    { success: true, data: { id: source.id, status: "PENDING" } },
    { status: 201 }
  );
}

/** The multipart branch of POST. Reads the file, then detaches the parse. */
async function createDocumentSource(
  request: NextRequest,
  workspaceId: string
): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "The upload could not be read" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { success: false, error: "Attach a file under the field name 'file'" },
      { status: 400 }
    );
  }

  const filename = (file.name || "upload").slice(0, 200);

  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: `${filename} is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1_000_000)} MB limit`,
      },
      { status: 400 }
    );
  }

  const kind = detectDocumentKind(filename, file.type);
  if (!kind) {
    return NextResponse.json(
      {
        success: false,
        error: `Only ${ACCEPTED_UPLOAD_EXTENSIONS.join(", ")} files can be read`,
      },
      { status: 400 }
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json(
      { success: false, error: `${filename} is empty` },
      { status: 400 }
    );
  }

  const rawTitle = form.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim() !== ""
      ? rawTitle.trim().slice(0, 120)
      : filename.slice(0, 120);

  const source = await prisma.knowledgeSource.create({
    data: {
      workspaceId,
      kind: "DOCUMENT",
      title,
      url: filename,
      status: "PENDING",
    },
    select: { id: true },
  });

  after(async () => {
    await runDocumentIngest(source.id, { bytes, kind, filename });
  });

  return NextResponse.json(
    { success: true, data: { id: source.id, status: "PENDING" } },
    { status: 201 }
  );
}

/**
 * Remove a source. Its chunks go with it through the schema's cascade.
 *
 * Scoped by workspaceId in the same statement as the id, so an id belonging to
 * another workspace deletes nothing and reads as a 404. There is deliberately
 * no separate lookup first, which would answer whether the id exists.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only owners and admins can remove knowledge sources",
      },
      { status: 403 }
    );
  }

  // The knowledge base is a paid feature and was reachable on every plan.
  const planGate = await checkPlanFeature(context.workspaceId, "knowledge_base");
  if (planGate) return planGate;

  const fromQuery = request.nextUrl.searchParams.get("id");
  const body: unknown = fromQuery
    ? { id: fromQuery }
    : await request.json().catch(() => ({}));

  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "id is required" },
      { status: 400 }
    );
  }

  const result = await prisma.knowledgeSource.deleteMany({
    where: { id: parsed.data.id, workspaceId: context.workspaceId },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "Source not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
