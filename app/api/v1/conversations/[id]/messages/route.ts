import { NextRequest } from "next/server";
import { GET as listMessages } from "@/app/api/instagram/conversations/[id]/route";
import { v1Error, v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most recent messages in one conversation, oldest first. accountId is required. */
export const GET = v1Route<{ id: string }>("conversations:read", (request, _caller, params) => {
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) return Promise.resolve(v1Error("accountId is required."));
  const url = new URL(request.url);
  url.searchParams.set("instagramAccountId", accountId);
  return listMessages(new NextRequest(url), { params: Promise.resolve({ id: params.id }) });
});
