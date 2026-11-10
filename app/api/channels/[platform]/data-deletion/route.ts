import { NextResponse } from "next/server";
import { deleteChannelUserData } from "@/lib/channels/compliance";
import { readComplianceCallback } from "@/lib/channels/compliance-routes";
import { getBaseUrl } from "@/lib/env";

type RouteProps = { params: Promise<{ platform: string }> };

/**
 * The platform asks, on a person's behalf, for their data to be deleted
 * (Meta's "Data deletion request URL"). Every account they connected is
 * deleted with everything under it, and the platform gets back the status
 * page and confirmation code it shows the person, in the shape Meta expects:
 * { url, confirmation_code }.
 */
export async function POST(request: Request, { params }: RouteProps): Promise<NextResponse> {
  const callback = await readComplianceCallback(request, (await params).platform);
  if (callback instanceof NextResponse) return callback;

  try {
    const { confirmationCode, accounts } = await deleteChannelUserData(
      callback.platform,
      callback.userId
    );
    console.log(`[Compliance] ${callback.platform} data deletion; ${accounts} account(s) deleted`);
    const url = new URL("/data-deletion/status", getBaseUrl());
    url.searchParams.set("code", confirmationCode);
    return NextResponse.json({ url: url.toString(), confirmation_code: confirmationCode });
  } catch (error) {
    console.error(
      "[Compliance] Data deletion failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return NextResponse.json({ error: "Could not process the request" }, { status: 500 });
  }
}
