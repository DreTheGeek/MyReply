import { v1Data, v1Error, v1Route } from "@/lib/api/v1";
import { partnerWorkspaceStatus } from "@/lib/partners/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workspace this credential acts in, with its connected accounts and how
 * each is doing. Any valid key may read it: a workspace key for its own, a
 * partner key for the one named in X-Workspace-Id.
 */
export const GET = v1Route(null, async (_request, caller) => {
  const status = await partnerWorkspaceStatus(null, caller.workspaceId);
  return status ? v1Data(status) : v1Error("Workspace not found.", 404);
});
