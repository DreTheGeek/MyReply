import { NextRequest } from "next/server";
import { GET as getStats } from "@/app/api/dashboard/stats/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Aggregate performance for the workspace, optionally for one account. */
export async function GET(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return getStats(request);
}
