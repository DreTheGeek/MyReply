"use client";

/**
 * Ask MyReply
 *
 * The chat in the portal's right rail. Built for a 300px sticky column: one
 * scrolling message list, a composer pinned to the bottom, nothing that needs
 * horizontal room.
 *
 * It calls POST /api/assistant, which is not streamed, so the pending state
 * carries the sense of progress: a live "working" line while the request is
 * open, then the trace of which tools actually ran attached to the answer.
 *
 * The name on this surface is Ask MyReply. Not an assistant, not a chief of
 * staff, not staff of any kind.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

interface ToolEvent {
  name: string;
  ok: boolean;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolEvent[];
  /** Set on an assistant turn we could not complete, so it renders as a fault. */
  failed?: boolean;
}

export interface AssistantPanelProps {
  /** Where the "add a key" prompt sends the user. */
  settingsHref?: string;
  /** Overrides the starter chips. Four or fewer reads best in the rail. */
  suggestions?: string[];
  /**
   * Skip the first status check when the parent already knows. Leave it unset
   * and the panel asks /api/workspace/ai-key on mount.
   */
  hasKey?: boolean;
  /** Extra classes on the outer panel. */
  className?: string;
}

/** Grounded in what the seven tools can actually answer. */
const DEFAULT_SUGGESTIONS: readonly string[] = [
  "Which campaign has the best click rate?",
  "Pause my slowest campaign",
  "Why did some DMs not send yesterday?",
  "Draft a DM for my next reel in my voice",
];

/** Tool names read like function names. These are what a person would say. */
const TOOL_LABELS: Record<string, string> = {
  list_instagram_accounts: "Checking connected accounts",
  list_recent_posts: "Looking through recent posts",
  list_campaigns: "Reading your campaigns",
  create_campaign: "Creating a campaign",
  update_campaign: "Updating a campaign",
  get_campaign_performance: "Checking performance",
  list_dm_logs: "Reading DM logs",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

let messageCounter = 0;

function nextId(): string {
  messageCounter += 1;
  return `m${messageCounter}`;
}

export default function AssistantPanel({
  settingsHref = "/settings",
  suggestions = [...DEFAULT_SUGGESTIONS],
  hasKey,
  className = "",
}: AssistantPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(
    hasKey ?? null
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hasKey !== undefined) return;
    let cancelled = false;

    async function loadStatus(): Promise<void> {
      try {
        const response = await fetch("/api/workspace/ai-key");
        const payload: unknown = await response.json();
        if (cancelled) return;
        const data =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).data
            : null;
        const configured =
          typeof data === "object" && data !== null
            ? Boolean((data as Record<string, unknown>).configured)
            : false;
        setKeyConfigured(configured);
      } catch {
        // Treat an unknown status as configured: a failed status check should
        // not hide the chat behind a "no key" prompt that may be wrong. The
        // send path returns the real answer either way.
        if (!cancelled) setKeyConfigured(true);
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [hasKey]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const question = text.trim();
      if (!question || sending) return;

      const outgoing: ChatMessage = {
        id: nextId(),
        role: "user",
        content: question,
      };
      const history = [...messages, outgoing];

      setMessages(history);
      setInput("");
      setSending(true);

      try {
        const response = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          code?: string;
          message?: string;
          error?: string;
          toolCalls?: ToolEvent[];
        };

        if (payload.ok && typeof payload.message === "string") {
          setMessages((current) => [
            ...current,
            {
              id: nextId(),
              role: "assistant",
              content: payload.message ?? "",
              toolCalls: payload.toolCalls ?? [],
            },
          ]);
          return;
        }

        if (payload.code === "no_key") {
          setKeyConfigured(false);
          return;
        }

        setMessages((current) => [
          ...current,
          {
            id: nextId(),
            role: "assistant",
            content: payload.error ?? "That did not go through. Try again.",
            failed: true,
          },
        ]);
      } catch {
        setMessages((current) => [
          ...current,
          {
            id: nextId(),
            role: "assistant",
            content: "That did not go through. Try again.",
            failed: true,
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [messages, sending]
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void send(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends, shift and enter makes a new line.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  if (keyConfigured === false) {
    return (
      <aside
        className={`flex flex-col gap-3 rounded border border-border bg-surface p-4 ${className}`}
      >
        <h2 className="text-sm font-medium text-foreground">Ask MyReply</h2>
        <p className="text-xs leading-relaxed text-muted">
          Add your own AI provider key and Ask MyReply can read your campaigns,
          check what is working and write DM copy in your voice.
        </p>
        <a
          href={settingsHref}
          className="rounded bg-accent px-3 py-2 text-center text-xs font-medium text-on-accent"
        >
          Add a key in Settings
        </a>
      </aside>
    );
  }

  const empty = messages.length === 0;

  return (
    <aside
      className={`flex h-full max-h-[calc(100vh-6rem)] flex-col rounded border border-border bg-surface ${className}`}
    >
      <header className="border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-medium text-foreground">Ask MyReply</h2>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
        {empty ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              I can read your campaigns, check how they are doing and change
              them for you. Try one of these.
            </p>
            <div className="flex flex-col gap-1.5">
              {suggestions.slice(0, 4).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  disabled={sending}
                  className="rounded border border-border px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {messages.map((message) => (
              <li key={message.id} className="text-xs leading-relaxed">
                {message.role === "user" ? (
                  <div className="rounded bg-accent px-2.5 py-2 text-on-accent">
                    {message.content}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {message.toolCalls && message.toolCalls.length > 0 ? (
                      <ul className="space-y-0.5">
                        {message.toolCalls.map((event, index) => (
                          <li
                            key={`${message.id}-${event.name}-${index}`}
                            className={
                              event.ok
                                ? "text-[11px] text-muted"
                                : "text-[11px] text-error"
                            }
                          >
                            {toolLabel(event.name)}
                            {event.ok ? "" : " failed"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p
                      className={
                        message.failed
                          ? "whitespace-pre-wrap text-error"
                          : "whitespace-pre-wrap text-foreground"
                      }
                    >
                      {message.content}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        {sending ? (
          <p className="mt-3 text-[11px] text-muted" aria-live="polite">
            Working on it...
          </p>
        ) : null}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-border p-2.5"
      >
        <label htmlFor="ask-myreply-input" className="sr-only">
          Ask MyReply a question
        </label>
        <textarea
          id="ask-myreply-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={sending}
          placeholder="Ask about your campaigns"
          className="w-full resize-none rounded border border-border bg-background px-2.5 py-2 text-xs text-foreground disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="mt-2 w-full rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
        >
          {sending ? "Working..." : "Send"}
        </button>
      </form>
    </aside>
  );
}
