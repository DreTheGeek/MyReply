import { NextRequest, NextResponse } from "next/server";
import { getRequestApiKeyContext } from "@/lib/auth";
import { MCP_TOOLS, mcpToolsForRole, runMcpTool } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP endpoint, JSON-RPC 2.0 over HTTP POST.
 *
 * Lets an AI agent read and write campaigns for one workspace. The workspace
 * comes from the API key, never from the request body, so a model cannot name
 * a tenant it was not given a key for.
 *
 * Connect with:
 *   url:     https://<domain>/api/mcp
 *   header:  Authorization: Bearer mr_live_...
 */

const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  // Always HTTP 200: a JSON-RPC error is a valid response, and returning 4xx
  // makes clients treat a tool-level failure as a transport failure.
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return rpcError(null, -32700, "Parse error");
  }

  const { id = null, method, params } = body as {
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };

  // A notification carries no id and expects no response body.
  if (method === "notifications/initialized") {
    return new NextResponse(null, { status: 202 });
  }

  const auth = await getRequestApiKeyContext();
  if (!auth) {
    return rpcError(
      id,
      -32001,
      "Unauthorized. Send an API key as: Authorization: Bearer mr_live_..."
    );
  }

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "myreply", version: "1.0.0" },
      });

    case "ping":
      return result(id, {});

    case "tools/list":
      // Filtered by the key's role, so a read-only key is never offered a
      // write tool it would only be refused on.
      return result(id, { tools: mcpToolsForRole(auth.role) });

    case "tools/call": {
      const toolName = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      if (!MCP_TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }

      try {
        const output = await runMcpTool(
          toolName,
          args,
          auth.workspaceId,
          auth.role
        );
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        });
      } catch (error) {
        // Reported as a tool result with isError rather than a JSON-RPC error,
        // which is what lets the model read the reason and correct itself
        // instead of seeing an opaque transport failure.
        const message =
          error instanceof Error ? error.message : "Tool execution failed";
        return result(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** A plain GET makes the endpoint self-describing for anyone who opens it. */
export async function GET() {
  return NextResponse.json({
    name: "myreply",
    protocol: "mcp",
    protocolVersion: PROTOCOL_VERSION,
    transport: "http",
    authentication: "Authorization: Bearer mr_live_...",
    tools: MCP_TOOLS.map((tool) => tool.name),
  });
}
