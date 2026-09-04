"use client";

/**
 * Command search. Cmd-K on a Mac, Ctrl-K elsewhere.
 *
 * Navigation and actions only. It deliberately does not search records: a
 * palette that half-searches your data is worse than one that is honest about
 * being a jump list, and the pages it lands on already have real search.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Command {
  id: string;
  label: string;
  group: string;
  href: string;
  keywords: string;
}

const COMMANDS: Command[] = [
  { id: "portal", label: "Portal", group: "Go to", href: "/dashboard", keywords: "home overview command center" },
  { id: "overview", label: "Analytics overview", group: "Go to", href: "/overview", keywords: "stats followers charts insights" },
  { id: "inbox", label: "Inbox", group: "Go to", href: "/inbox", keywords: "conversations messages dm" },
  { id: "campaigns", label: "Campaigns", group: "Go to", href: "/campaigns", keywords: "automations keywords triggers" },
  { id: "contacts", label: "Contacts", group: "Go to", href: "/contacts", keywords: "people audience tags" },
  { id: "answers", label: "Answers", group: "Go to", href: "/answers", keywords: "ai review corrections knowledge handoff" },
  { id: "logs", label: "DM logs", group: "Go to", href: "/logs", keywords: "delivery sends failures history" },
  { id: "diagnostics", label: "Diagnostics", group: "Go to", href: "/diagnostics", keywords: "health worker queue redis alerts" },
  { id: "settings", label: "Settings", group: "Go to", href: "/settings", keywords: "team workspace account preferences" },
  { id: "new-campaign", label: "New campaign", group: "Actions", href: "/campaigns/new", keywords: "create add automation" },
  { id: "connect", label: "Connect an Instagram account", group: "Actions", href: "/api/instagram/connect", keywords: "instagram oauth link add account" },
  { id: "api-keys", label: "API keys and MCP", group: "Actions", href: "/settings#api-keys", keywords: "api key mcp agent token integration developer" },
  { id: "starters", label: "Conversation starters", group: "Actions", href: "/settings#conversation-starters", keywords: "ice breakers prompts dm" },
];

export default function CommandPalette(): React.JSX.Element | null {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const results = useMemo((): Command[] => {
    const needle = query.trim().toLowerCase();
    if (!needle) return COMMANDS;
    return COMMANDS.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        command.keywords.includes(needle)
    );
  }, [query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        restoreFocusTo.current = document.activeElement as HTMLElement | null;
        setOpen((previous) => !previous);
        setQuery("");
        setActive(0);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // The palette can also be opened by the top bar button, so listen for that
    // rather than lifting open state into a provider for one consumer.
    function onOpen(): void {
      restoreFocusTo.current = document.activeElement as HTMLElement | null;
      setOpen(true);
      setQuery("");
      setActive(0);
    }
    window.addEventListener("myreply:open-command", onOpen);
    return () => window.removeEventListener("myreply:open-command", onOpen);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else restoreFocusTo.current?.focus();
  }, [open]);

  if (!open) return null;

  function close(): void {
    setOpen(false);
  }

  function run(command: Command): void {
    close();
    // The connect route is a server redirect into Meta, not an app route.
    if (command.href.startsWith("/api/")) window.location.href = command.href;
    else router.push(command.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = results[active];
      if (command) run(command);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="panel w-full max-w-lg overflow-hidden rounded-lg shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command search"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Search pages and actions"
          aria-label="Search pages and actions"
          className="w-full border-b border-border bg-transparent px-4 py-3.5 text-sm text-foreground outline-none placeholder:text-muted"
        />

        <ul className="max-h-80 overflow-y-auto py-1" role="listbox">
          {results.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted">
              Nothing matches that
            </li>
          )}
          {results.map((command, index) => {
            // Derived from the neighbour rather than a variable mutated during
            // render, which does not survive a re-render the way it appears to.
            const showGroup = command.group !== results[index - 1]?.group;
            return (
              <li key={command.id}>
                {showGroup && (
                  <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {command.group}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(command)}
                  className={`block w-full px-4 py-2 text-left text-sm ${
                    index === active
                      ? "bg-surface-hover text-foreground"
                      : "text-muted"
                  }`}
                >
                  {command.label}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
          Arrow keys to move, Enter to open, Esc to close
        </p>
      </div>
    </div>
  );
}
