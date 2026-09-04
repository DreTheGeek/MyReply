import { NextRequest } from "next/server";
import {
  GET as listAutomations,
  POST as createAutomation,
  PATCH as updateAutomation,
  DELETE as deleteAutomation,
} from "@/app/api/automations/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Campaigns, the v1 surface.
 *
 * Delegates to the same handlers the dashboard calls, so validation, workspace
 * scoping and role checks cannot drift between the two. The only thing added
 * here is the requirement that the caller present an API key rather than a
 * session cookie.
 */

export async function GET(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return listAutomations(request);
}

export async function POST(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return createAutomation(request);
}

export async function PATCH(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return updateAutomation(request);
}

export async function DELETE(request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return deleteAutomation(request);
}
