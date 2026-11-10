import { v1Data, v1Error, v1Route } from "@/lib/api/v1";
import { apiSendSchema, sendApiMessage } from "@/lib/messaging/api-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a text message to someone who wrote to the account in the last 24
 * hours. Requires an Idempotency-Key, so a retry after a dropped connection
 * never sends twice. "unconfirmed" means the platform's answer was ambiguous
 * and the message may have arrived; do not send it again.
 */
export const POST = v1Route(
  "messages:send",
  async (request, caller) => {
    const parsed = apiSendSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return v1Error("accountId, recipientId and text (up to 1000 characters) are required.");

    const result = await sendApiMessage(caller.workspaceId, parsed.data);
    if (!result.ok) return v1Error(result.error, result.status);
    return v1Data(
      { status: result.status, messageId: result.messageId, recipientId: result.recipientId },
      result.status === "sent" ? 201 : 202
    );
  },
  { requireIdempotencyKey: true }
);
