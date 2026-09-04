"use client";

/**
 * Portal left rail: identity and navigation.
 *
 * Per PORTAL-LAYOUT-STANDARD, top to bottom: wordmark, owner card, workspace
 * switcher, the full module list with count badges on whatever needs
 * attention, then help, what is new, and log out pinned to the bottom.
 *
 * The badge counts come from the portal summary. A module with nothing wrong
 * shows no badge at all rather than a zero, so a badge always means "look
 * here".
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import WorkspaceSwitcher from "@/components/workspace-switcher";
import { signOutAction } from "@/lib/actions/session";

interface NavItem {
  label: string;
  href: string;
}

const navItems: NavItem[] = [
  { label: "Portal", href: "/dashboard" },
  { label: "Overview", href: "/overview" },
  { label: "Inbox", href: "/inbox" },
  { label: "Campaigns", href: "/campaigns" },
  { label: "Contacts", href: "/contacts" },
  { label: "Answers", href: "/answers" },
  { label: "DM Logs", href: "/logs" },
  { label: "Settings", href: "/settings" },
  { label: "Diagnostics", href: "/diagnostics" },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  workspaceId: string;
  userName: string | null;
  userEmail: string | null;
  role: string;
  /** Attention counts keyed by href. Absent or zero renders no badge. */
  badges: Record<string, number>;
}

function initialsFrom(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || "";
  if (!source) return "?";
  const parts = source.split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
  workspaceId,
  userName,
  userEmail,
  role,
  badges,
}: SidebarProps): React.JSX.Element {
  const pathname = usePathname();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
          role="presentation"
        />
      )}

      <aside
        className={`
          fixed left-0 top-0 z-50 flex h-dvh w-64 max-w-[85vw] flex-col border-r border-border bg-surface
          transition-transform duration-200 ease-out
          lg:sticky lg:z-auto lg:w-auto lg:max-w-none lg:translate-x-0
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        <div className="px-5 pb-3 pt-4">
          <Link
            href="/dashboard"
            onClick={onClose}
            className="font-display text-base font-bold tracking-tight text-accent"
          >
            MyReply
          </Link>
        </div>

        {/* Owner card */}
        <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-hover font-mono text-xs font-medium text-foreground">
            {initialsFrom(userName, userEmail)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">
              {userName ?? userEmail ?? "Signed in"}
            </p>
            <p className="truncate text-[10px] uppercase tracking-wide text-muted">
              {role.toLowerCase()}
            </p>
          </div>
        </div>

        <div className="px-3 pb-3">
          <WorkspaceSwitcher
            workspaceName={workspaceName}
            workspaceId={workspaceId}
          />
        </div>

        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const badge = badges[item.href] ?? 0;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={`
                  flex items-center justify-between gap-2 rounded px-3 py-2 text-sm
                  ${
                    isActive
                      ? "bg-surface-hover font-medium text-accent"
                      : "text-muted hover:bg-surface-hover hover:text-foreground"
                  }
                `}
              >
                <span className="truncate">{item.label}</span>
                {badge > 0 && (
                  <span className="shrink-0 rounded-full bg-error px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-2 border-t border-border px-3 py-3">
          <div className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-xs font-medium text-foreground">Need a hand?</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Instagram limits and messaging windows are explained in the docs.
            </p>
            <a
              href="mailto:support@laseanpickens.com"
              className="mt-1.5 inline-block text-[11px] font-medium text-accent hover:underline"
            >
              Email support
            </a>
          </div>

          <div className="flex items-center justify-between px-1">
            <Link
              href="/settings"
              onClick={onClose}
              className="text-[11px] text-muted hover:text-foreground"
            >
              What is new
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="text-[11px] text-muted hover:text-foreground"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
