/**
 * Per-reply cost: what each provider reports, and what is kept.
 */

import { describe, expect, it, vi } from "vitest";
import { callProvider } from "../lib/ai/client";

function respond(body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

const base = {
  model: "m",
  apiKey: "sk-test-0123456789abcdef",
  system: "s",
  tools: [],
  messages: [{ role: "user" as const, text: "hi", toolCalls: [], toolResults: [] }],
};

describe("provider usage", () => {
  it("keeps OpenRouter's own cost, in millionths of a dollar", async () => {
    const turn = await callProvider({
      ...base,
      provider: "OPENROUTER",
      fetchImpl: respond({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.00056 },
      }),
    });
    expect(turn.usage).toEqual({ inputTokens: 1200, outputTokens: 80, costMicros: 560 });
  });

  it("keeps Anthropic's tokens and leaves cost unknown rather than estimated", async () => {
    const turn = await callProvider({
      ...base,
      provider: "ANTHROPIC",
      fetchImpl: respond({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 40 },
      }),
    });
    expect(turn.usage).toEqual({ inputTokens: 900, outputTokens: 40, costMicros: null });
  });

  it("reports nothing when the provider sent no usage", async () => {
    const turn = await callProvider({
      ...base,
      provider: "OPENROUTER",
      fetchImpl: respond({ choices: [{ message: { content: "ok" } }] }),
    });
    expect(turn.usage).toBeNull();
  });
});
