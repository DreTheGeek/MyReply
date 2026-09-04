import { NextRequest, NextResponse } from "next/server";
import { MCP_TOOLS, mcpToolsForRole, runMcpTool } from "@/lib/mcp/tools";
import { corsPreflight } from "@/lib/oauth/errors";
import {
  authenticateMcpRequest,
  insufficientScopeResponse,
  toolNeedsWriteScope,
} from "@/lib/oauth/mcp-auth";
import { SCOPE_WRITE } from "@/lib/oauth/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP endpoint, JSON-RPC 2.0 over HTTP POST.
 *
 * Lets an AI agent read and write campaigns for one workspace. The workspace
 * comes from the credential, never from the request body, so a model cannot
 * name a tenant it was not given access to.
 *
 * Two ways in, both resolving to the same workspace and role:
 *   url:     https://<domain>/api/mcp
 *   OAuth:   paste the URL into a client and click Connect
 *   API key: Authorization: Bearer mr_live_...
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

  // A missing or bad credential answers with a real 401 carrying the RFC 9728
  // WWW-Authenticate challenge, not a JSON-RPC error. That header is what tells
  // a client where the authorization server is, and it is the difference
  // between a client offering a Connect button and the user hunting for a key.
  const authenticated = await authenticateMcpRequest(request);
  if (!authenticated.ok) {
    return authenticated.response;
  }
  const auth = authenticated.credential;

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

      // Scope is checked before the role gate, so an OAuth client that was
      // never granted write access is told which scope it is missing rather
      // than being told its role is too low. An API key carries no scopes and
      // skips this: its role alone decides, exactly as it always did.
      if (
        auth.scopes !== null &&
        toolNeedsWriteScope(toolName) &&
        !auth.scopes.includes(SCOPE_WRITE)
      ) {
        return insufficientScopeResponse(request, toolName);
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
    authentication: [
      "OAuth 2.1 with PKCE, discovered from /.well-known/oauth-protected-resource/api/mcp",
      "Authorization: Bearer mr_live_... for scripts and headless clients",
    ],
    tools: MCP_TOOLS.map((tool) => tool.name),
  });
}

/** Browser-based MCP clients preflight before they can read WWW-Authenticate. */
export async function OPTIONS() {
  return corsPreflight();
}
