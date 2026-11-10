import { v1Data, v1Error, v1Route } from "@/lib/api/v1";
import { runMcpTool } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One campaign's complete settings, with its links in button order. The same
 * read the MCP get_campaign tool makes, so the two cannot disagree.
 */
export const GET = v1Route<{ id: string }>("campaigns:read", async (_request, caller, params) => {
  try {
    return v1Data(await runMcpTool("get_campaign", { id: params.id }, caller.workspaceId, caller.scopes));
  } catch (error) {
    if (error instanceof Error && /^Unknown campaign/.test(error.message)) {
      return v1Error("That campaign was not found in this workspace.", 404);
    }
    throw error;
  }
});
