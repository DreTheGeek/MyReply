import { NextRequest } from "next/server";
import { GET as listConversations } from "@/app/api/instagram/conversations/route";
import { v1Error, v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One account's conversations, newest first, as the platform holds them.
 * accountId is required, so a call never quietly reads a different account.
 */
export const GET = v1Route("conversations:read", (request) => {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return Promise.resolve(v1Error("accountId is required."));
  const url = new URL(request.url);
  url.searchParams.set("instagramAccountId", accountId);
  return listConversations(new NextRequest(url));
});
