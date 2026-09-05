import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { POST as createAutomation } from "@/app/api/automations/route";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  invalidateOnboardingCache,
  onboardingCacheKey,
} from "@/lib/onboarding/cache";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * What activation accepts.
 *
 * Deliberately shallow. The campaign fields are validated by the create route
 * itself, which owns that schema; restating it here would be a second copy
 * that drifts, and a draft that passed onboarding's copy but failed the real
 * one would fail at the moment someone taps Activate. So this checks only what
 * onboarding is responsible for, and hands the rest to the authority.
 *
 * `instagramAccountId` is accepted but never trusted: whatever arrives is
 * discarded and replaced with an account resolved from the caller's own
 * workspace.
 */
const activateSchema = z.object({
  draftId: z.string().min(1).max(200),
  instagramAccountId: z.string().min(1).max(200).nullable().optional(),
  automation: z.record(z.string(), z.unknown()),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }

  const parsed = activateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  // The tenant boundary. The account is looked up by workspace, so a draft
  // carrying another workspace's account id resolves to this workspace's own
  // account or to nothing at all. It never reaches across.
  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId ?? null
  );

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error: "Connect Instagram before turning on an automation.",
      },
      { status: 400 }
    );
  }

  // Reuse the real creation path rather than writing a second one, so
  // validation, role gating, tracked-link creation and workspace scoping
  // cannot drift from the campaign builder's. The delegated handler reads the
  // session from the ambient request context, not from this object, so it sees
  // exactly the caller it would have seen had they posted to it directly.
  const createRequest = new NextRequest(
    new URL("/api/automations", request.nextUrl.origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...parsed.data.automation,
        instagramAccountId: account.id,
      }),
    }
  );

  const created = await createAutomation(createRequest);

  // A draft that is now a live campaign must not still be offered as a
  // suggestion on the next load.
  if (created.status === 201) {
    invalidateOnboardingCache(
      onboardingCacheKey(context.workspaceId, account.id)
    );
  }

  return created;
}
