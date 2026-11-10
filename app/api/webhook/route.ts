import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  parseCommentEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { processInstagramWebhook } from "@/lib/queue/process-webhook";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // This is the common symptom of FACEBOOK_APP_SECRET being set to the
    // wrong app's secret for the webhook's signing key, and while it is
    // happening no comment reaches any campaign. So it has to be loud.
    //
    // The OperationalEvent below is written with no workspaceId, because at
    // this point the payload has not been parsed and no tenant is known. The
    // operator fleet view reads it; the console line also reaches a human
    // through the platform's own log search.
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

  try {
    await processInstagramWebhook({
      payload: payload as Parameters<typeof parseCommentEvents>[0],
      provider: "META",
    });
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
