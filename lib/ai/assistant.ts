/**
 * Ask MyReply: the tool-use loop behind the portal's right rail.
 *
 * The assistant's tools are exactly the seven MCP tools the public API already
 * exposes. There is no parallel tool set, so anything the assistant can do, an
 * external agent holding an API key could already do, and a change to one is a
 * change to both.
 *
 * The single security invariant in this file: the workspace id handed to
 * runMcpTool comes from the caller's session and nowhere else. Model-supplied
 * arguments are scrubbed of anything that looks like a tenant id before they
 * reach a handler, so a prompt-injected model cannot name another workspace.
 */

import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { mcpToolsForRole, runMcpTool, type McpTool } from "@/lib/mcp/tools";
import {
  callProvider,
  type AiMessage,
  type AiToolResult,
  type AiTurn,
  type FetchLike,
} from "@/lib/ai/client";
import type { AiProviderId } from "@/lib/ai/providers";

/**
 * Model calls per request. Six is room for a read, a follow-up read and a
 * write with a summary afterwards, and short enough that a model stuck in a
 * retry loop costs the workspace a handful of calls rather than a budget.
 */
export const MAX_TOOL_ITERATIONS = 6;

/** Turns of history we accept from the client. */
export const MAX_INPUT_MESSAGES = 24;

/** Characters per inbound message. */
export const MAX_MESSAGE_CHARS = 4000;

/** Characters of one tool result we feed back. Log lists can be long. */
const MAX_TOOL_RESULT_CHARS = 8000;

/** Argument names a model must never be able to set. */
const TENANT_ARG_KEYS = new Set([
  "workspaceId",
  "workspace_id",
  "workspace",
  "tenantId",
  "tenant_id",
  "accountId",
]);

export interface AssistantToolEvent {
  name: string;
  ok: boolean;
  /** Present only when the tool failed. Safe to show; it is our own wording. */
  error?: string;
}

export interface AssistantRunResult {
  message: string;
  toolEvents: AssistantToolEvent[];
  /** Model calls actually made. */
  iterations: number;
  /** True when the loop stopped at the cap rather than because the model did. */
  hitIterationCap: boolean;
}

export type RunToolFn = (
  name: string,
  args: Record<string, unknown>,
  workspaceId: string,
  role: WorkspaceRole
) => Promise<Record<string, unknown>>;

export type CallModelFn = (options: {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  system: string;
  tools: McpTool[];
  messages: AiMessage[];
  fetchImpl?: FetchLike;
}) => Promise<AiTurn>;

export interface RunAssistantOptions {
  /** From the session. The only workspace id the tools will ever see. */
  workspaceId: string;
  /**
   * From the session too. It decides which tools the model is even shown, so a
   * MEMBER's assistant cannot offer to create a campaign and then be refused.
   */
  role: WorkspaceRole;
  workspaceName?: string;
  provider: AiProviderId;
  model: string;
  apiKey: string;
  messages: AiMessage[];
  /** Test seams. Production passes neither. */
  runTool?: RunToolFn;
  callModel?: CallModelFn;
}

export function buildSystemPrompt(workspaceName?: string): string {
  const workspace = workspaceName?.trim()
    ? `The workspace is called "${workspaceName.trim()}".`
    : "";

  return [
    "You are Ask MyReply, the assistant inside MyReply, a tool that turns Instagram comments into DMs.",
    `You are working inside exactly one workspace and you can only ever see that workspace's data. ${workspace}`.trim(),
    "",
    "How to work:",
    "- You have tools that read and change this workspace's campaigns. Use them. Do not describe what the user could click, do the thing and then say what you did.",
    "- Before you recommend changing a campaign, look at how it is actually performing. get_campaign_performance and list_dm_logs are cheap; guessing is not. Advice with no numbers behind it is worse than no advice.",
    "- Read before you write. Find the campaign or the account with a list tool before you create or update anything, so you are acting on a real id.",
    "- If a tool fails, say what failed and what you need in order to retry. Never invent a result.",
    "",
    "Writing DMs:",
    "- Anything you write in dmMessage or a public reply is sent verbatim to a real person from the account owner's own account. Write it in the owner's voice, the way they talk in their captions, not in marketing copy.",
    "- Short. One idea. No emoji unless the owner already uses them. No placeholder brackets. {username} becomes the commenter's handle and {link} becomes the tracked link; those two are the only tokens that work.",
    "- Before you send a campaign live with copy you wrote, show the user the exact text.",
    "",
    "How to answer:",
    "- Plain, specific, short. This renders in a narrow side panel, so keep paragraphs to a couple of lines and skip the preamble.",
    "- Numbers over adjectives. Say which campaign, what the rate was, and over what period.",
    "- If the user asks for something the tools cannot do, say so plainly instead of approximating it.",
  ].join("\n");
}

/**
 * Drop tenant-naming arguments before a handler sees them.
 *
 * The MCP handlers already scope every query by the workspaceId they are
 * passed, so this is belt and braces. It exists because the cost of being wrong
 * here is cross-tenant data, and because a future handler could be written less
 * carefully than the current seven.
 */
export function sanitizeToolArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (TENANT_ARG_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`;
}

export async function runAssistant(
  options: RunAssistantOptions
): Promise<AssistantRunResult> {
  const runTool: RunToolFn = options.runTool ?? runMcpTool;
  const callModel: CallModelFn = options.callModel ?? callProvider;
  const system = buildSystemPrompt(options.workspaceName);
  // Offer only what this role may actually call. runMcpTool refuses a write
  // from a MEMBER regardless; withholding the tool means the model never
  // promises something it will then fail to do.
  const tools = mcpToolsForRole(options.role);
  const toolNames = new Set(tools.map((tool) => tool.name));

  const conversation: AiMessage[] = [...options.messages];
  const toolEvents: AssistantToolEvent[] = [];
  let lastText = "";
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;

    const turn = await callModel({
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      system,
      tools,
      messages: conversation,
    });

    conversation.push(turn.message);
    if (turn.message.text) lastText = turn.message.text;

    if (turn.message.toolCalls.length === 0) {
      return {
        message: lastText,
        toolEvents,
        iterations,
        hitIterationCap: false,
      };
    }

    const toolResults: AiToolResult[] = [];

    for (const call of turn.message.toolCalls) {
      if (!toolNames.has(call.name)) {
        toolEvents.push({
          name: call.name,
          ok: false,
          error: "Unknown tool",
        });
        toolResults.push({
          toolCallId: call.id,
          name: call.name,
          content: `Unknown tool: ${call.name}`,
          isError: true,
        });
        continue;
      }

      try {
        const output = await runTool(
          call.name,
          sanitizeToolArgs(call.input),
          // Both from the session, every time. Never call.input.
          options.workspaceId,
          options.role
        );
        toolEvents.push({ name: call.name, ok: true });
        toolResults.push({
          toolCallId: call.id,
          name: call.name,
          content: truncate(JSON.stringify(output)),
          isError: false,
        });
      } catch (error) {
        // The handlers throw plain messages written for a model to read and
        // correct itself, which is why the reason is fed back rather than
        // flattened into a generic failure.
        const message =
          error instanceof Error ? error.message : "Tool execution failed";
        toolEvents.push({ name: call.name, ok: false, error: message });
        toolResults.push({
          toolCallId: call.id,
          name: call.name,
          content: message,
          isError: true,
        });
      }
    }

    conversation.push({
      role: "user",
      text: "",
      toolCalls: [],
      toolResults,
    });
  }

  return {
    message:
      lastText ||
      "I ran out of steps before I could finish that. Ask me for one thing at a time and I will get further.",
    toolEvents,
    iterations,
    hitIterationCap: true,
  };
}
