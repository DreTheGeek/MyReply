import { GET as listLogs } from "@/app/api/logs/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DM delivery log, filterable and paginated. */
export const GET = v1Route("campaigns:read", (request) => listLogs(request));
