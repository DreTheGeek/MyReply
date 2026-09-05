import { NextResponse, after } from "next/server";
import { checkPlanFeature } from "@/lib/plan-gate";
import { prisma } from "@/lib/db/client";
import { runWebsiteIngest } from "@/lib/knowledge/ingest";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

/**
 * Re-crawl a website source.
 *
 * The source is looked up with its workspaceId in the same query as its id, so
 * an id from another workspace is a 404 rather than a 403. A 403 would confirm
 * the id exists, which is a tenant enumeration oracle.
 *
 * Only a WEBSITE can be re-synced. A MANUAL pair has nothing to re-fetch, and a
 * DOCUMENT's bytes lived only in the request that uploaded them, so both get a
 * plain explanation instead of a silent no-op.
 */
export async function POST(
  _request: Request,
  { params }: RouteProps
): Promise<NextResponse> {
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
        error: "Only owners and admins can re-sync knowledge sources",
      },
      { status: 403 }
    );
  }

  // Re-ingesting is the same paid feature as adding a source.
  const planGate = await checkPlanFeature(context.workspaceId, "knowledge_base");
  if (planGate) return planGate;

  const { id } = await params;

  const source = await prisma.knowledgeSource.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true, kind: true, url: true, status: true },
  });

  if (!source) {
    return NextResponse.json(
      { success: false, error: "Source not found" },
      { status: 404 }
    );
  }

  if (source.kind === "MANUAL") {
    return NextResponse.json(
      {
        success: false,
        error: "A question and answer has nothing to re-sync. Edit or remove it.",
      },
      { status: 400 }
    );
  }

  if (source.kind === "DOCUMENT") {
    return NextResponse.json(
      {
        success: false,
        error:
          "Uploaded files are not kept after they are read. Upload the file again to refresh it.",
      },
      { status: 400 }
    );
  }

  if (!source.url) {
    return NextResponse.json(
      { success: false, error: "This source has no address to crawl" },
      { status: 400 }
    );
  }

  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { status: "PENDING", errorMessage: null },
  });

  after(async () => {
    await runWebsiteIngest(source.id);
  });

  return NextResponse.json({
    success: true,
    data: { id: source.id, status: "PENDING" },
  });
}
