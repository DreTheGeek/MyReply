"use client";

/**
 * The three-zone portal shell.
 *
 * Left rail is identity and navigation, the centre column is the work and is
 * the only thing that scrolls the page, and the right rail is triage plus the
 * assistant. Both rails are full height and sticky.
 *
 * The right rail needs 300px of its own before it stops stealing room from the
 * work, so below xl it becomes a drawer opened from the top bar rather than a
 * squeezed column. The nav does the same below lg.
 */

import { useState } from "react";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";
import AssistantPanel from "@/components/portal/assistant-panel";
import CommandPalette from "@/components/portal/command-palette";
import PortalRail from "@/components/portal/portal-rail";
import { PortalProvider, usePortal } from "@/components/portal/portal-context";

interface DashboardShellProps {
  children: React.ReactNode;
  workspaceName: string;
  workspaceId: string;
  instagramUsername: string | null;
  instagramAccountCount: number;
  userName: string | null;
  userEmail: string | null;
  role: string;
}

export default function DashboardShell(
  props: DashboardShellProps
): React.JSX.Element {
  return (
    <PortalProvider>
      <PortalLayout {...props} />
    </PortalProvider>
  );
}

function PortalLayout({
  children,
  workspaceName,
  workspaceId,
  instagramUsername,
  instagramAccountCount,
  userName,
  userEmail,
  role,
}: DashboardShellProps): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const { summary, loading } = usePortal();

  const tasks = summary?.tasks ?? [];
  const alerts = summary?.alerts.items ?? [];
  const alertTotal = summary?.alerts.total ?? 0;

  // A badge means "something here needs you", so each one counts only the
  // tasks and alerts that the page in question can actually resolve.
  const badges: Record<string, number> = {
    "/logs": tasks.filter((task) => task.id.startsWith("failed-")).length,
    "/settings": tasks.filter(
      (task) => task.id.startsWith("token-") || task.id.startsWith("webhook-")
    ).length,
    "/campaigns": tasks.filter((task) => task.id.startsWith("campaign-")).length,
    "/diagnostics": alerts.filter((alert) => alert.level === "ERROR").length,
  };

  const rail = (
    <PortalRail
      alerts={alerts}
      alertTotal={alertTotal}
      tasks={tasks}
      usage={summary?.usage ?? null}
      assistant={<AssistantPanel />}
      loading={loading}
    />
  );

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden bg-background lg:grid-cols-[224px_minmax(0,1fr)] xl:grid-cols-[224px_minmax(0,1fr)_300px]">
      <Sidebar
        isOpen={navOpen}
        onClose={() => setNavOpen(false)}
        workspaceName={workspaceName}
        workspaceId={workspaceId}
        userName={userName}
        userEmail={userEmail}
        role={role}
        badges={badges}
      />

      <div className="flex min-w-0 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setNavOpen(true)}
          onRailClick={() => setRailOpen(true)}
          instagramUsername={instagramUsername}
          instagramAccountCount={instagramAccountCount}
          userName={userName}
          userEmail={userEmail}
          alertCount={alertTotal + tasks.length}
        />

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="px-4 py-5 lg:px-6">{children}</div>
        </main>
      </div>

      {/* Rail as a column, xl and up */}
      <div className="hidden h-dvh xl:block">{rail}</div>

      {/* Rail as a drawer, below xl */}
      {railOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 xl:hidden"
          onClick={() => setRailOpen(false)}
          role="presentation"
        />
      )}
      <div
        className={`
          fixed right-0 top-0 z-50 h-dvh w-80 max-w-[85vw] transition-transform duration-200 ease-out xl:hidden
          ${railOpen ? "translate-x-0" : "translate-x-full"}
        `}
        aria-hidden={!railOpen}
      >
        {rail}
      </div>

      <CommandPalette />
    </div>
  );
}
