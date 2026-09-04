/**
 * The provider HTTP layer.
 *
 * Raw fetch rather than a vendor SDK, for two reasons. MyReply has no AI SDK in
 * its dependencies and this task may not add one. And BYOK means two wire
 * formats behind one loop: Anthropic's Messages API and OpenRouter's
 * OpenAI-compatible chat completions. A single normalised shape in the middle
 * costs less than two SDKs and an adapter between them.
 *
 * Nothing in this file logs. A key is a function argument here and nowhere
 * else, and the only text that travels back out is run through redactKey first.
 */

import type { McpTool } from "@/lib/mcp/tools";
import {
  type AiProviderId,
  MAX_KEY_LENGTH,
  MIN_KEY_LENGTH,
  redactKey,
} from "@/lib/ai/providers";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Ceiling on one assistant reply. Chat answers, not documents. */
export const MAX_OUTPUT_TOKENS = 4096;

/** A provider call that hangs is a hung request for the user. */
export const PROVIDER_TIMEOUT_MS = 60_000;

export type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiToolResult {
  toolCallId: string;
  name: string;
  /** Already serialised. Providers want a string here, not an object. */
  content: string;
  isError: boolean;
}

export interface AiMessage {
  role: "user" | "assistant";
  /** Plain prose for this turn. Empty when the turn is only tool traffic. */
  text: string;
  toolCalls: AiToolCall[];
  toolResults: AiToolResult[];
  /**
   * An assistant turn's provider-native content blocks, kept verbatim.
   *
   * Anthropic requires thinking blocks to be replayed unchanged on the same
   * model, and they cannot be reconstructed from the normalised fields. Keeping
   * the original array makes a replay lossless instead of quietly dropping a
   * block the provider expects to see again.
   */
  providerContent?: unknown;
}

export interface AiTurn {
  message: AiMessage;
  stopReason: string;
}

/**
 * A failure the user is allowed to read. `status` is the provider's, and
 * `message` is the provider's own wording so an expired key or a bad model id
 * says so rather than surfacing as "something went wrong".
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

function defaultFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readErrorMessage(
  response: Response,
  apiKey: string
): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  let detail = "";

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") {
      detail = error;
    } else if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") detail = message;
    }
    if (!detail && typeof record.message === "string") detail = record.message;
  }

  if (!detail) detail = `Provider returned ${response.status}`;
  return redactKey(detail.slice(0, 400), apiKey);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

function anthropicTools(tools: McpTool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function anthropicMessages(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      if (message.providerContent !== undefined) {
        return { role: "assistant", content: message.providerContent };
      }
      const content: unknown[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      return { role: "assistant", content };
    }

    // Tool results have to lead the user turn; Anthropic rejects them anywhere
    // else in the block list.
    const content: unknown[] = message.toolResults.map((result) => ({
      type: "tool_result",
      tool_use_id: result.toolCallId,
      content: result.content,
      is_error: result.isError,
    }));
    if (message.text) content.push({ type: "text", text: message.text });
    return { role: "user", content };
  });
}

function parseAnthropicTurn(payload: unknown): AiTurn {
  const record = toRecord(payload);
  const blocks = Array.isArray(record.content) ? record.content : [];

  const textParts: string[] = [];
  const toolCalls: AiToolCall[] = [];

  for (const raw of blocks) {
    const block = toRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: toRecord(block.input),
      });
    }
  }

  return {
    message: {
      role: "assistant",
      text: textParts.join("\n").trim(),
      toolCalls,
      toolResults: [],
      providerContent: blocks,
    },
    stopReason: String(record.stop_reason ?? "end_turn"),
  };
}

/* -------------------------------------------------------------------------- */
/* OpenRouter (OpenAI-compatible)                                             */
/* -------------------------------------------------------------------------- */

function openRouterTools(tools: McpTool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * One normalised turn can become several wire messages here: OpenAI's format
 * puts every tool result in its own `role: "tool"` message rather than grouping
 * them under the user turn the way Anthropic does.
 */
function openRouterMessages(system: string, messages: AiMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "assistant") {
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: message.text || null,
      };
      if (message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        }));
      }
      out.push(entry);
      continue;
    }

    for (const result of message.toolResults) {
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }
    if (message.text) out.push({ role: "user", content: message.text });
  }

  return out;
}

function parseOpenRouterTurn(payload: unknown): AiTurn {
  const record = toRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = toRecord(choices[0]);
  const message = toRecord(choice.message);

  const text = typeof message.content === "string" ? message.content : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const toolCalls: AiToolCall[] = rawCalls.map((raw) => {
    const call = toRecord(raw);
    const fn = toRecord(call.function);
    let input: Record<string, unknown> = {};
    if (typeof fn.arguments === "string" && fn.arguments.trim()) {
      // Never string-match serialised arguments; escaping differs by model.
      try {
        input = toRecord(JSON.parse(fn.arguments));
      } catch {
        input = {};
      }
    }
    return { id: String(call.id ?? ""), name: String(fn.name ?? ""), input };
  });

  return {
    message: {
      role: "assistant",
      text: text.trim(),
      toolCalls,
      toolResults: [],
    },
    stopReason: String(choice.finish_reason ?? "stop"),
  };
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface CallProviderOptions {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  system: string;
  tools: McpTool[];
  messages: AiMessage[];
  fetchImpl?: FetchLike;
}

export async function callProvider(
  options: CallProviderOptions
): Promise<AiTurn> {
  const doFetch = options.fetchImpl ?? defaultFetch;
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);

  const isAnthropic = options.provider === "ANTHROPIC";

  const url = isAnthropic
    ? `${ANTHROPIC_BASE}/v1/messages`
    : `${OPENROUTER_BASE}/chat/completions`;

  const headers: Record<string, string> = isAnthropic
    ? {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        // OpenRouter attributes traffic by these two, and they are the only
        // way a workspace can see which app spent its balance.
        "x-title": "MyReply",
        "http-referer": "https://myreply.app",
      };

  const body = isAnthropic
    ? {
        model: options.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: options.system,
        tools: anthropicTools(options.tools),
        messages: anthropicMessages(options.messages),
      }
    : {
        model: options.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: openRouterTools(options.tools),
        messages: openRouterMessages(options.system, options.messages),
      };

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    // Deliberately not surfacing the underlying error: a fetch failure message
    // can carry the request URL and headers.
    throw new ProviderError(
      "Could not reach the AI provider. Try again in a moment.",
      503,
      true
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      await readErrorMessage(response, options.apiKey),
      response.status,
      isRetryableStatus(response.status)
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null) {
    throw new ProviderError(
      "The AI provider returned a response we could not read.",
      502,
      true
    );
  }

  return isAnthropic
    ? parseAnthropicTurn(payload)
    : parseOpenRouterTurn(payload);
}

export interface ValidationResult {
  ok: boolean;
  /** The provider's own wording when it refused, already redacted. */
  error?: string;
}

/**
 * One cheap real call, made before a key is ever written to the database.
 *
 * Both endpoints authenticate without generating a single token, so validating
 * a key costs the workspace nothing. The Anthropic one doubles as a model
 * check: an unknown model id comes back 404 while a bad key comes back 401, so
 * the owner is told which of the two they got wrong.
 */
export async function validateProviderKey(
  provider: AiProviderId,
  model: string,
  apiKey: string,
  fetchImpl?: FetchLike
): Promise<ValidationResult> {
  if (apiKey.length < MIN_KEY_LENGTH || apiKey.length > MAX_KEY_LENGTH) {
    return { ok: false, error: "That does not look like a provider key." };
  }

  const doFetch = fetchImpl ?? defaultFetch;
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);

  const url =
    provider === "ANTHROPIC"
      ? `${ANTHROPIC_BASE}/v1/models/${encodeURIComponent(model)}`
      : `${OPENROUTER_BASE}/key`;

  const headers: Record<string, string> =
    provider === "ANTHROPIC"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : { authorization: `Bearer ${apiKey}` };

  let response: Response;
  try {
    response = await doFetch(url, { method: "GET", headers, signal });
  } catch {
    return {
      ok: false,
      error: "Could not reach the provider to check that key. Try again.",
    };
  }

  if (response.ok) return { ok: true };

  if (provider === "ANTHROPIC" && response.status === 404) {
    return {
      ok: false,
      error: `The key works, but this account cannot use the model "${model}". Pick a different model.`,
    };
  }

  return { ok: false, error: await readErrorMessage(response, apiKey) };
}
