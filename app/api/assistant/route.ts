import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_INPUT_MESSAGES,
  MAX_MESSAGE_CHARS,
  runAssistant,
} from "@/lib/ai/assistant";
import { ProviderError, type AiMessage } from "@/lib/ai/client";
import { checkAssistantRateLimit } from "@/lib/ai/rate-limit";
import {
  getWorkspaceAiCredential,
  touchWorkspaceAiKey,
} from "@/lib/ai/workspace-key";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/assistant, the chat behind the portal's right rail.
 *
 * Response contract, always JSON:
 *
 *   200 { ok: true,  message, toolCalls: [{ name, ok, error? }],
 *         iterations, truncated }
 *   200 { ok: false, code: "no_key",         error }
 *   200 { ok: false, code: "provider_error", error, status }
 *   400 { ok: false, code: "invalid_request", error }
 *   401 { ok: false, code: "unauthorized",    error }
 *   429 { ok: false, code: "rate_limited",    error, retryAfterSeconds }
 *   500 { ok: false, code: "assistant_failed", error }
 *
 * "no key configured" and "your provider said no" are 200s on purpose. Both are
 * expected states of a BYOK product with a rendering in the panel, and a 500
 * would make the panel show a crash where it should show "add a key in
 * Settings" or the provider's own sentence.
 *
 * Not streamed. The loop calls the provider, runs MCP tools, feeds the results
 * back and repeats, across two different provider wire formats. A stream would
 * mean interleaving tool execution with partial deltas in both formats and
 * inventing an error frame for a failure that arrives mid-body; the panel shows
 * live tool activity from its own pending state and the returned toolCalls
 * trace instead. A correct answer beats a fragile stream.
 */

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_INPUT_MESSAGES),
});

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { ok: false, code: "unauthorized", error: "Sign in to use Ask MyReply." },
      { status: 401 }
    );
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        error: `Send between 1 and ${MAX_INPUT_MESSAGES} messages, each under ${MAX_MESSAGE_CHARS} characters.`,
      },
      { status: 400 }
    );
  }

  const inbound = parsed.data.messages;
  if (inbound[inbound.length - 1].role !== "user") {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        error: "The last message has to be from the user.",
      },
      { status: 400 }
    );
  }

  // Counted after the caller is known, so an unauthenticated flood cannot eat a
  // real workspace's allowance.
  const limit = checkAssistantRateLimit(context.workspaceId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        error: "Too many questions at once. Give it a moment.",
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSeconds) },
      }
    );
  }

  const credential = await getWorkspaceAiCredential(context.workspaceId);
  if (!credential) {
    return NextResponse.json({
      ok: false,
      code: "no_key",
      error:
        "Ask MyReply runs on your own AI provider key. Add one in Settings to turn it on.",
    });
  }

  // History arrives as prose only. Earlier tool traffic is deliberately not
  // replayed: the client would have to hold provider-shaped blocks it has no
  // business holding, and a stale tool result is worse input than none. The
  // model re-reads with the tools when it needs the numbers again.
  const messages: AiMessage[] = inbound.map((message) => ({
    role: message.role,
    text: message.content,
    toolCalls: [],
    toolResults: [],
  }));

  try {
    const result = await runAssistant({
      workspaceId: context.workspaceId,
      role: context.role,
      workspaceName: context.workspace.name,
      provider: credential.provider,
      model: credential.model,
      apiKey: credential.apiKey,
      messages,
    });

    touchWorkspaceAiKey(context.workspaceId);

    return NextResponse.json({
      ok: true,
      message: result.message,
      toolCalls: result.toolEvents,
      iterations: result.iterations,
      truncated: result.hitIterationCap,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      // The provider's own wording, already stripped of anything key-shaped.
      // "Your credit balance is too low" is only useful if we pass it through.
      return NextResponse.json({
        ok: false,
        code: "provider_error",
        error: error.message,
        status: error.status,
      });
    }

    // Anything else is ours. Logged server side, sanitised on the way out.
    console.error("[assistant] run failed", {
      workspaceId: context.workspaceId,
      name: error instanceof Error ? error.name : "unknown",
    });

    return NextResponse.json(
      {
        ok: false,
        code: "assistant_failed",
        error: "Ask MyReply could not finish that. Try again.",
      },
      { status: 500 }
    );
  }
}
