"use client";

/**
 * Workspace Switcher
 *
 * Lets a user who belongs to more than one workspace choose which one they are
 * acting in. Renders as plain text for the common single-workspace case so the
 * sidebar footer does not grow a control that does nothing.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
}

interface WorkspaceSwitcherProps {
  workspaceName: string;
  workspaceId: string;
}

export default function WorkspaceSwitcher({
  workspaceName,
  workspaceId,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/workspace/switch")
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled || !payload.success) return;
        setWorkspaces(payload.data.workspaces ?? []);
      })
      .catch(() => {
        // A failed list just means no switcher. The page still works.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSwitch(nextId: string) {
    if (nextId === workspaceId || switching) return;

    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: nextId }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.success) {
        setError(payload.error ?? "Could not switch workspace");
        return;
      }
      // Every page reads the workspace on the server, so a refresh is what
      // actually swaps the data. router.refresh keeps the client tree alive.
      router.refresh();
    } catch {
      setError("Could not switch workspace");
    } finally {
      setSwitching(false);
    }
  }

  if (workspaces.length < 2) {
    return (
      <>
        <p className="text-sm text-foreground truncate">{workspaceName}</p>
        <p className="text-xs text-muted">Workspace</p>
      </>
    );
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">Workspace</span>
      <select
        value={workspaceId}
        disabled={switching}
        onChange={(event) => handleSwitch(event.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent disabled:opacity-60"
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-error">{error}</span>}
    </label>
  );
}
