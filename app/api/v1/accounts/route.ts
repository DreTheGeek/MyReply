import { GET as listAccounts } from "@/app/api/instagram/accounts/route";
import { v1Route } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The accounts this key's workspace has connected, on every platform. */
export const GET = v1Route("accounts:read", () => listAccounts());
