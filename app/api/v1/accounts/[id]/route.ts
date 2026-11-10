import { NextRequest } from "next/server";
import { POST as disconnectAccount } from "@/app/api/instagram/disconnect/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect an account. Its campaigns, contacts and history go with it, the
 * same as disconnecting in the dashboard, and it is recorded in the audit log.
 */
export const DELETE = v1Route<{ id: string }>("accounts:write", (request, _caller, params) =>
  disconnectAccount(
    new NextRequest(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instagramAccountId: params.id }),
    })
  )
);
