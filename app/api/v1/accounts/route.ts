import { NextResponse } from "next/server";
import { GET as listAccounts } from "@/app/api/instagram/accounts/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Instagram accounts this key's workspace has connected.
 *
 * Takes no request argument: the key is read from the ambient request headers,
 * and the underlying handler needs nothing from the URL.
 */
export async function GET(): Promise<NextResponse> {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return listAccounts();
}
