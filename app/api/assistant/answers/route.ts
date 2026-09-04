import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_ANSWER_PAGE_SIZE,
  MAX_ANSWER_PAGE_SIZE,
  listAssistantAnswers,
} from "@/lib/ai/answer-review";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/assistant/answers
 *
 * The review queue. Every answer the assistant gave a customer in this
 * workspace, newest first, with the two filters that matter to a person working
 * the queue:
 *
 *   ?unreviewed=1  answers nobody has ruled on yet
 *   ?handedOff=1   answers that were never sent and are waiting for a reply
 *
 * Readable by any member. Reviewing is the write, and that is gated separately
 * on the review route.
 */

const querySchema = z.object({
  unreviewed: z.enum(["0", "1"]).optional(),
  handedOff: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ANSWER_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    unreviewed: params.get("unreviewed") ?? undefined,
    handedOff: params.get("handedOff") ?? undefined,
    limit: params.get("limit") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid filters" },
      { status: 400 }
    );
  }

  try {
    const result = await listAssistantAnswers({
      workspaceId: context.workspaceId,
      unreviewedOnly: parsed.data.unreviewed === "1",
      handedOffOnly: parsed.data.handedOff === "1",
      limit: parsed.data.limit ?? DEFAULT_ANSWER_PAGE_SIZE,
      cursor: parsed.data.cursor ?? null,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[assistant-answers] list failed", {
      workspaceId: context.workspaceId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { success: false, error: "Could not load the review queue." },
      { status: 500 }
    );
  }
}
