import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  adapterForWebhookPayload,
  webhookAdapters,
} from "@/lib/channels/registry";
import { processChannelWebhook } from "@/lib/queue/process-webhook";

/**
 * Meta's webhook endpoint.
 *
 * Every Meta platform delivers to this one callback URL, signed with the same
 * app secret, so the route serves every adapter registered under the "meta"
 * endpoint and lets each payload's own adapter parse it. Today that is
 * Instagram; a Facebook Page adapter joins it without a new route.
 */

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  for (const adapter of webhookAdapters("meta")) {
    const challenge = adapter.webhook.verifyChallenge(params);
    if (challenge !== null) {
      return new NextResponse(challenge, { status: 200 });
    }
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const adapters = webhookAdapters("meta");

  // Checked before the body is parsed, so nothing unsigned is ever read.
  const signed = adapters.some((adapter) =>
    adapter.webhook.verifySignature(rawBody, request.headers)
  );

  if (!signed) {
    // This is the common symptom of FACEBOOK_APP_SECRET being set to the
    // wrong app's secret for the webhook's signing key, and while it is
    // happening no comment reaches any campaign. So it has to be loud.
    //
    // The OperationalEvent below is written with no workspaceId, because at
    // this point the payload has not been parsed and no tenant is known. The
    // operator fleet view reads it; the console line also reaches a human
    // through the platform's own log search.
    const signature = request.headers.get("x-hub-signature-256");
    console.error(
      "[Webhook] Signature verification failed.",
      `hadSignatureHeader=${Boolean(signature)} bodyLength=${rawBody.length}.`,
      "If this repeats, FACEBOOK_APP_SECRET is probably the wrong app's secret."
    );
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "WARNING",
          message: "Webhook signature verification failed",
          payload: {
            hadSignatureHeader: Boolean(signature),
            bodyLength: rawBody.length,
            bodyPreview: rawBody.slice(0, 200),
          },
        },
      })
      // Swallowing this silently would have hidden the failure to record the
      // failure. The console line above has already gone out either way.
      .catch((error: unknown) => {
        console.error("[Webhook] Could not record the signature failure", error);
      });
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // A signed payload for a product no adapter handles yet (a Meta object
  // type this engine has not added) is acknowledged and ignored, so Meta does
  // not keep retrying it.
  const adapter = adapterForWebhookPayload(payload, adapters);
  if (!adapter) {
    return NextResponse.json({ success: true }, { status: 200 });
  }

  try {
    await processChannelWebhook({ adapter, payload });
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    // Already recorded on the WebhookEvent row. A non-2xx makes Meta retry,
    // and every job id is deterministic, so the retry cannot double-send.
    console.error(
      "[Webhook] Processing failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
