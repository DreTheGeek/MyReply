"use client";

/**
 * Portal top bar.
 *
 * Page title on the left, the command search centred, then the triage and
 * identity controls. Per PORTAL-LAYOUT-STANDARD the search is the wayfinding
 * organ, so it is the visual centre of this bar rather than an icon in a
 * corner.
 */

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/portal/theme-toggle";

/** The platform cannot change mid-session, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {};
}

const pageTitles: Record<string, string> = {
  "/dashboard": "Portal",
  "/overview": "Overview",
  "/inbox": "Inbox",
  "/campaigns": "Campaigns",
  "/campaigns/new": "New campaign",
  "/automations": "Campaigns",
  "/automations/new": "New campaign",
  "/contacts": "Contacts",
  "/templates": "Templates",
  "/onboarding": "Setup",
  "/answers": "Answers",
  "/logs": "DM logs",
  "/settings": "Settings",
  "/diagnostics": "Diagnostics",
};

interface TopBarProps {
  onMenuClick: () => void;
  onRailClick: () => void;
  instagramUsername: string | null;
  instagramAccountCount: number;
  userName: string | null;
  userEmail: string | null;
  alertCount: number;
}

/**
 * Magic-link sign-in leaves the display name null, so falling back only to a
 * question mark would give most accounts a permanently anonymous avatar. The
 * email local part is derived the same way the sidebar owner card does it, so
 * the two agree.
 */
function initialsFrom(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || "";
  if (!source) return "?";
  const parts = source.split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export default function TopBar({
  onMenuClick,
  onRailClick,
  instagramUsername,
  instagramAccountCount,
  userName,
  userEmail,
  alertCount,
}: TopBarProps): React.JSX.Element {
  const pathname = usePathname();
  // An exact match only, with "Portal" as the fallback, meant every dynamic
  // route said "Portal": on /campaigns/abc the bar told you you were on the
  // dashboard. The longest matching prefix wins so /campaigns/abc/edit reads
  // as Campaigns rather than as somewhere else entirely.
  const title =
    pageTitles[pathname] ??
    Object.entries(pageTitles)
      .filter(([route]) => pathname.startsWith(`${route}/`))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ??
    "Portal";

  // The server cannot know the platform, so it renders the Ctrl hint and the
  // client corrects it during hydration. Reading it through a snapshot rather
  // than state plus an effect keeps the two renders honest about that.
  const modifier = useSyncExternalStore(
    subscribeToNothing,
    () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl"),
    () => "Ctrl"
  );

  function openCommand(): void {
    window.dispatchEvent(new Event("myreply:open-command"));
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:px-6">
      <button
        onClick={onMenuClick}
        className="shrink-0 rounded border border-border px-2.5 py-1.5 text-sm text-muted hover:text-foreground lg:hidden"
        aria-label="Open navigation"
      >
        Menu
      </button>

      <h1 className="hidden shrink-0 truncate text-sm font-semibold text-foreground sm:block sm:w-40">
        {title}
      </h1>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={openCommand}
          className="flex w-full max-w-sm items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-muted transition-colors hover:border-border-hover"
        >
          <span className="truncate">Search pages and actions</span>
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {modifier} K
          </kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {instagramAccountCount === 0 && (
          <a
            href="/api/instagram/connect"
            className="hidden whitespace-nowrap rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover sm:inline-block"
          >
            Connect Instagram
          </a>
        )}

        <p className="hidden text-xs text-muted xl:block">
          {instagramAccountCount > 1
            ? `${instagramAccountCount} accounts`
            : instagramUsername
              ? `@${instagramUsername}`
              : ""}
        </p>

        <ThemeToggle />

        <button
          type="button"
          onClick={onRailClick}
          aria-label={
            alertCount > 0
              ? `${alertCount} items need attention`
              : "What needs you"
          }
          className="relative inline-flex h-8 w-8 items-center justify-center rounded border border-border text-muted hover:border-border-hover hover:text-foreground xl:hidden"
        >
          <span aria-hidden="true" className="text-sm leading-none">
            ◉
          </span>
          {alertCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 font-mono text-[10px] leading-none text-white">
              {alertCount > 9 ? "9+" : alertCount}
            </span>
          )}
        </button>

        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-hover font-mono text-xs font-medium text-foreground"
          title={userName ?? userEmail ?? undefined}
        >
          {initialsFrom(userName, userEmail)}
        </span>
      </div>
    </header>
  );
}
