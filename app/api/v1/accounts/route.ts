import { NextRequest } from "next/server";
import { GET as listAccounts } from "@/app/api/instagram/accounts/route";
import { isRejection, requireApiKey } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Instagram accounts this key's workspace has connected. */
export async function GET(_request: NextRequest) {
  const caller = await requireApiKey();
  if (isRejection(caller)) return caller;
  return listAccounts();
}
