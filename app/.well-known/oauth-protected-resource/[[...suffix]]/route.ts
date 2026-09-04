import { NextResponse } from "next/server";
import {
  MCP_RESOURCE_PATH,
  endpointsForIssuer,
  resolveIssuer,
} from "@/lib/oauth/config";
import { CORS_HEADERS, corsPreflight } from "@/lib/oauth/errors";
import { SUPPORTED_SCOPES } from "@/lib/oauth/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 Protected Resource Metadata. Mandatory for an MCP server.
 *
 * This is the document a client fetches after a 401 tells it where to look. It
 * says which authorization server can issue tokens for this resource, and what
 * scopes exist, which is everything needed to start the flow without anybody
 * pasting a key anywhere.
 *
 * The optional catch-all is why this route exists in this shape. RFC 9728 puts
 * the protected resource's own path after the well-known segment, so the
 * canonical URL is /.well-known/oauth-protected-resource/api/mcp, while plenty
 * of clients still ask for the bare /.well-known/oauth-protected-resource. One
 * optional catch-all answers both; two separate routes would collide.
 *
 * On Next 16 a directory literally named `.well-known` under app/ is scanned
 * and routed normally, so no rewrite is needed. Only path parts beginning with
 * an underscore are skipped by the router, not ones beginning with a dot.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ suffix?: string[] }> }
): Promise<NextResponse> {
  const { suffix } = await context.params;

  // Only this server's own resource path is described here. A request for some
  // other path is a request about a resource that does not exist.
  if (suffix && suffix.length > 0) {
    const requestedPath = `/${suffix.join("/")}`;
    if (requestedPath !== MCP_RESOURCE_PATH) {
      return NextResponse.json(
        { error: "not_found", error_description: "No such protected resource." },
        { status: 404, headers: CORS_HEADERS }
      );
    }
  }

  const endpoints = endpointsForIssuer(resolveIssuer(request));

  return NextResponse.json(
    {
      resource: endpoints.resource,
      authorization_servers: [endpoints.issuer],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "MyReply MCP",
    },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return corsPreflight();
}
