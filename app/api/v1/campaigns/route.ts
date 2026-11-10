import {
  GET as listAutomations,
  POST as createAutomation,
  PATCH as updateAutomation,
  DELETE as deleteAutomation,
} from "@/app/api/automations/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Campaigns, the v1 surface.
 *
 * Delegates to the same handlers the dashboard calls, so validation, workspace
 * scoping and role checks cannot drift between the two. The door adds the key,
 * the scope and the rate limit.
 */

export const GET = v1Route("campaigns:read", (request) => listAutomations(request));
export const POST = v1Route("campaigns:write", (request) => createAutomation(request));
export const PATCH = v1Route("campaigns:write", (request) => updateAutomation(request));
export const DELETE = v1Route("campaigns:write", (request) => deleteAutomation(request));
