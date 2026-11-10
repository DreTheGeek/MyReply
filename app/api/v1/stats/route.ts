import { GET as getStats } from "@/app/api/dashboard/stats/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Aggregate performance for the workspace, optionally for one account. */
export const GET = v1Route("campaigns:read", (request) => getStats(request));
