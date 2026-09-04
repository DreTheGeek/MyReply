import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_CORRECTION_CHARS,
  reviewAssistantAnswer,
} from "@/lib/ai/answer-review";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/assistant/answers/[id]/review
 *
 * Record GOOD or WRONG. A WRONG carries the correction, and the correction is
 * written back into the knowledge base as a MANUAL source, so this is a write
 * to what the assistant will say next time, not just a label on what it said.
 * That is why it is gated on ADMIN: a member who can read the queue cannot
 * change what customers get told.
 */

const bodySchema = z
  .object({
    verdict: z.enum(["GOOD", "WRONG"]),
    correction: z.string().trim().max(MAX_CORRECTION_CHARS).optional(),
  })
  .refine(
    (value) => value.verdict !== "WRONG" || Boolean(value.correction),
    { message: "A wrong answer needs a correction.", path: ["correction"] }
  );

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(
  request: NextRequest,
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
        error: "Only owners and admins can review assistant answers",
      },
      { status: 403 }
    );
  }

  const { id } = await params;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error:
          parsed.error.issues[0]?.message ??
          "Send a verdict of GOOD or WRONG, with a correction for WRONG.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await reviewAssistantAnswer({
      workspaceId: context.workspaceId,
      answerId: id,
      verdict: parsed.data.verdict,
      correction: parsed.data.correction ?? null,
    });

    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 400;
      const error =
        result.error === "not_found"
          ? "That answer does not exist in this workspace."
          : "A wrong answer needs a correction.";
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({
      success: true,
      data: {
        verdict: result.verdict,
        knowledgeSourceId: result.knowledgeSourceId,
        // The one thing the reviewer wants to know: did the correction land
        // somewhere the assistant will read it again.
        fedBack: result.knowledgeSourceId !== null,
      },
    });
  } catch (error) {
    console.error("[assistant-answers] review failed", {
      workspaceId: context.workspaceId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { success: false, error: "Could not record that review." },
      { status: 500 }
    );
  }
}
