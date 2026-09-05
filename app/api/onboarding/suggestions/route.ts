import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { decryptToken } from "@/lib/meta/oauth";
import {
  onboardingCacheKey,
  withOnboardingCache,
} from "@/lib/onboarding/cache";
import { suggestOnboardingDrafts } from "@/lib/onboarding/suggest";
import type { OnboardingSuggestions } from "@/lib/onboarding/types";
import { getWorkspaceTone, toneSchema, type Tone } from "@/lib/suggestions";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

// Suggestions are read from a live Instagram account for the signed-in
// workspace. Nothing here may be cached at the route or CDN layer, where it
// would be served across tenants.
export const dynamic = "force-dynamic";

const querySchema = z.object({
  instagramAccountId: z.string().min(1).max(200).nullable().optional(),
  // An explicit tone overrides the workspace's saved one, for a preview.
  tone: toneSchema.nullable().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const parsed = querySchema.safeParse({
    instagramAccountId: request.nextUrl.searchParams.get("instagramAccountId"),
    tone: request.nextUrl.searchParams.get("tone"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input" },
      { status: 400 }
    );
  }

  // Scoped to the caller's workspace, so a suggestion can only ever be built
  // from an account this workspace actually owns.
  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId ?? null
  );

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error: "Connect Instagram to see automations built for your account.",
      },
      { status: 400 }
    );
  }

  // The workspace row is already loaded on the context, so the saved voice
  // costs no extra query. An unset or unrecognised value resolves to the
  // default rather than failing the page.
  const tone: Tone = parsed.data.tone ?? getWorkspaceTone(context.workspace);

  let suggestions: OnboardingSuggestions;
  try {
    suggestions = await withOnboardingCache(
      `${onboardingCacheKey(context.workspaceId, account.id)}:${tone}`,
      async () =>
        suggestOnboardingDrafts({
          accessToken: decryptToken(account.accessToken),
          account: { id: account.id, username: account.username },
          tone,
        })
    );
  } catch (error) {
    // suggestOnboardingDrafts swallows Meta failures itself, so reaching here
    // means the stored token could not be decrypted at all. The internal
    // reason stays server-side.
    console.error("[Onboarding] Could not build suggestions:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          "We could not read your Instagram account. Reconnect it in Settings and try again.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { success: true, data: suggestions },
    { headers: { "Cache-Control": "no-store" } }
  );
}
