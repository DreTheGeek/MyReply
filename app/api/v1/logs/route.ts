import { NextRequest } from "next/server";
import { GET as listLogs } from "@/app/api/logs/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DM delivery log, filterable and paginated. */
export async function GET(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return listLogs(request);
}
