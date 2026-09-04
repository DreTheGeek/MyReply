import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildPortalSummary } from "@/lib/portal/summary";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the portal renders, in one request.
 *
 * The nav badges, the right rail and the portal page all read from this, so
 * splitting it would cost three round trips and let the three surfaces
 * disagree with each other on screen.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const requested = request.nextUrl.searchParams.get("instagramAccountId");

  // "all" and an absent value both mean every account. A named id is resolved
  // through the workspace first, so a foreign id is a 404 rather than a filter
  // we honour. It is never passed to getWorkspaceInstagramAccount as "all",
  // which would resolve to whichever account connected most recently.
  let instagramAccountId: string | null = null;
  if (requested && requested !== "all") {
    const account = await getWorkspaceInstagramAccount(
      context.workspaceId,
      requested
    );
    if (!account) {
      return NextResponse.json(
        { success: false, error: "Instagram account not found" },
        { status: 404 }
      );
    }
    instagramAccountId = account.id;
  }

  // An API key has no human behind it, so the greeting falls back to null
  // rather than inventing a name.
  const session = await auth();

  const data = await buildPortalSummary({
    workspaceId: context.workspaceId,
    userName: session?.user?.name ?? null,
    instagramAccountId,
  });

  return NextResponse.json({ success: true, data });
}
