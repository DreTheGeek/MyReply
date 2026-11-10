import { NextResponse } from "next/server";
import { deauthorizeChannelUser } from "@/lib/channels/compliance";
import { readComplianceCallback } from "@/lib/channels/compliance-routes";

type RouteProps = { params: Promise<{ platform: string }> };

/**
 * The platform says a person removed the app (Meta's "Deauthorize callback
 * URL"). Their token is erased and their accounts' campaigns are paused. The
 * request must carry a signed_request signed with this app's secret, or
 * nothing happens.
 */
export async function POST(request: Request, { params }: RouteProps): Promise<NextResponse> {
  const callback = await readComplianceCallback(request, (await params).platform);
  if (callback instanceof NextResponse) return callback;

  try {
    const { accounts } = await deauthorizeChannelUser(callback.platform, callback.userId);
    console.log(`[Compliance] ${callback.platform} app removed; ${accounts} account(s) paused`);
    return NextResponse.json({ success: true });
  } catch (error) {
    // A 500 makes the platform retry, which is what should happen.
    console.error(
      "[Compliance] Deauthorize failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return NextResponse.json({ error: "Could not process the request" }, { status: 500 });
  }
}
