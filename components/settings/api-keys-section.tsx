"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** The origin never changes within a page view, so there is nothing to watch. */
function subscribeToNothing(): () => void {
  return () => {};
}

export type WorkspaceRoleName = "OWNER" | "ADMIN" | "MEMBER";

/**
 * One key as the list endpoint reports it. There is deliberately no field for
 * the key itself: the plaintext exists only in the create response, so a row
 * rendered from a list can never leak one.
 */
interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  role: WorkspaceRoleName;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** The create response, which carries the plaintext exactly once. */
interface CreatedApiKey extends ApiKeyRow {
  key: string;
}

export interface ApiKeysSectionProps {
  /**
   * The signed-in user's role in this workspace, or null while it is still
   * loading. Owners and admins can create and revoke; members read only, which
   * mirrors the gate the API itself applies.
   */
  currentUserRole: WorkspaceRoleName | null;
}

const EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: "No expiry", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString();
}

function statusOf(key: ApiKeyRow): { label: string; className: string } {
  if (key.revokedAt) {
    return { label: "Revoked", className: "border-error/30 text-error" };
  }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: "Expired", className: "border-border text-muted" };
  }
  return { label: "Active", className: "border-accent/40 text-accent" };
}

export default function ApiKeysSection({
  currentUserRole,
}: ApiKeysSectionProps): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("ADMIN");
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle"
  );
  // Read from the live origin so the panel shows the host someone actually
  // points an MCP client at. useSyncExternalStore rather than state plus an
  // effect: there is nothing to subscribe to, only a server value and a
  // client value, which is exactly what its two snapshot functions are for.
  const mcpUrl = useSyncExternalStore(
    subscribeToNothing,
    () => `${window.location.origin}/api/mcp`,
    () => "/api/mcp"
  );
  const keyFieldRef = useRef<HTMLInputElement | null>(null);

  const canManage = currentUserRole === "OWNER" || currentUserRole === "ADMIN";

  useEffect(() => {
    let cancelled = false;

    fetch("/api/workspace/api-keys")
      .then((res) => res.json())
      .then((payload: { success: boolean; data?: { keys: ApiKeyRow[] } }) => {
        if (cancelled) return;
        if (!payload.success || !payload.data) {
          setError("Could not load API keys");
          return;
        }
        setKeys(payload.data.keys);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load API keys");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);


  async function createKey(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy("create");

    try {
      const res = await fetch("/api/workspace/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          role,
          ...(expiryDays === null ? {} : { expiresInDays: expiryDays }),
        }),
      });
      const payload: { success: boolean; data?: CreatedApiKey; error?: string } =
        await res.json();

      if (!payload.success || !payload.data) {
        setError(payload.error ?? "Could not create the key");
        return;
      }

      const created = payload.data;
      setCreatedKey(created);
      setCopyState("idle");
      // The row is rebuilt field by field rather than spread, so the plaintext
      // cannot ride along into the list. Only the reveal panel holds it.
      setKeys((existing) => [
        {
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          role: created.role,
          createdAt: created.createdAt,
          lastUsedAt: created.lastUsedAt,
          expiresAt: created.expiresAt,
          revokedAt: created.revokedAt,
        },
        ...existing,
      ]);
      setName("");
      setExpiryDays(null);
      setRole("ADMIN");
      setFormOpen(false);
    } catch {
      setError("Could not create the key");
    } finally {
      setBusy(null);
    }
  }

  async function copyCreatedKey(): Promise<void> {
    const value = createdKey?.key;
    if (!value) return;

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopyState("copied");
        return;
      }
    } catch {
      // The clipboard API is missing or blocked, which is normal over plain
      // http and in a denied-permission browser. Handled by selecting the
      // field below so the button never silently does nothing.
    }

    const field = keyFieldRef.current;
    if (field) {
      field.focus();
      field.select();
    }
    setCopyState("manual");
  }

  function dismissReveal(): void {
    // The plaintext leaves component state here and is not recoverable.
    setCreatedKey(null);
    setCopyState("idle");
  }

  async function revokeKey(key: ApiKeyRow): Promise<void> {
    if (
      !confirm(
        `Revoke "${key.name}"? Anything still using this key stops working on its next request. This cannot be undone.`
      )
    ) {
      return;
    }

    setError(null);
    setBusy(`revoke:${key.id}`);

    try {
      const res = await fetch("/api/workspace/api-keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: key.id }),
      });
      const payload: { success: boolean; error?: string } = await res.json();

      if (!payload.success) {
        setError(payload.error ?? "Could not revoke the key");
        return;
      }

      const revokedAt = new Date().toISOString();
      setKeys((existing) =>
        existing.map((row) => (row.id === key.id ? { ...row, revokedAt } : row))
      );
    } catch {
      setError("Could not revoke the key");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">API keys</h2>
      <p className="text-xs text-muted mb-6">
        A key lets a program or an AI agent drive this workspace: the REST API
        at <code className="font-mono">/api/v1</code> and the MCP server both
        authenticate with one. A key reaches only this workspace, is shown once
        when you create it, and can be revoked at any time.
      </p>

      {loading ? (
        <div className="h-24 rounded border border-border bg-surface/70" />
      ) : (
        <div className="space-y-4">
          {createdKey && (
            <div className="rounded border border-accent/40 bg-surface p-4">
              <p className="text-sm font-semibold text-foreground">
                Copy {createdKey.name} now
              </p>
              <p className="mt-1 text-xs text-error font-medium">
                This is the only time this key is ever shown. Only its hash is
                stored, so nobody, including us, can show it to you again. If
                you lose it, revoke it and make another.
              </p>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  ref={keyFieldRef}
                  type="text"
                  readOnly
                  value={createdKey.key}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Your new API key"
                  className="w-full rounded border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copyCreatedKey()}
                  className="shrink-0 rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
                >
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
              </div>

              {copyState === "manual" && (
                <p className="mt-2 text-xs text-muted">
                  This browser did not allow copying, which is normal over plain
                  http. The key is selected above, so press Ctrl+C, or Cmd+C on
                  a Mac.
                </p>
              )}

              <button
                type="button"
                onClick={dismissReveal}
                className="mt-3 rounded border border-border px-4 py-2 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
              >
                I have saved it, hide the key
              </button>
            </div>
          )}

          {keys.length === 0 ? (
            <div className="rounded border border-border bg-surface/70 p-4">
              <p className="text-sm font-medium text-foreground">
                No API keys yet
              </p>
              <p className="mt-1 text-xs text-muted">
                A key is how something other than this dashboard reaches your
                campaigns. Give one to your own code against{" "}
                <code className="font-mono">/api/v1</code>, or hand one to an AI
                agent so it can create and manage campaigns for you in plain
                language.
              </p>
              <p className="mt-3 text-xs text-muted">
                To connect an MCP client such as Claude, point it at{" "}
                <code className="font-mono break-all">{mcpUrl}</code> with an{" "}
                <code className="font-mono">Authorization: Bearer</code> header
                carrying the key.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Name
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Key
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Role
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Created
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Last used
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Status
                    </th>
                    {canManage && <th className="pb-2" />}
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => {
                    const status = statusOf(key);
                    return (
                      <tr key={key.id} className="border-b border-border last:border-0">
                        <td className="py-3 pr-3 font-medium text-foreground">
                          {key.name}
                        </td>
                        <td className="py-3 pr-3 font-mono text-xs text-muted">
                          {key.prefix}...
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {key.role}
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {formatDate(key.createdAt)}
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}
                          >
                            {status.label}
                          </span>
                        </td>
                        {canManage && (
                          <td className="py-3 text-right">
                            {key.revokedAt ? null : (
                              <button
                                type="button"
                                onClick={() => void revokeKey(key)}
                                disabled={busy === `revoke:${key.id}`}
                                className="rounded border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
                              >
                                {busy === `revoke:${key.id}`
                                  ? "Revoking..."
                                  : "Revoke"}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {canManage ? (
            formOpen ? (
              <form
                onSubmit={createKey}
                className="space-y-3 rounded border border-border bg-surface/70 p-4"
              >
                <div>
                  <label
                    htmlFor="api-key-name"
                    className="mb-1.5 block text-xs font-medium text-muted"
                  >
                    Name
                  </label>
                  <input
                    id="api-key-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                    required
                    placeholder="Claude on my laptop"
                    className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                  />
                  <p className="mt-1 text-xs text-muted">
                    What is holding this key, so you know what breaks when you
                    revoke it.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="api-key-expiry"
                      className="mb-1.5 block text-xs font-medium text-muted"
                    >
                      Expiry
                    </label>
                    <select
                      id="api-key-expiry"
                      value={expiryDays === null ? "" : String(expiryDays)}
                      onChange={(event) =>
                        setExpiryDays(
                          event.target.value === ""
                            ? null
                            : Number(event.target.value)
                        )
                      }
                      className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                    >
                      {EXPIRY_OPTIONS.map((option) => (
                        <option
                          key={option.label}
                          value={option.days === null ? "" : String(option.days)}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="api-key-role"
                      className="mb-1.5 block text-xs font-medium text-muted"
                    >
                      Role
                    </label>
                    <select
                      id="api-key-role"
                      value={role}
                      onChange={(event) =>
                        setRole(event.target.value as "ADMIN" | "MEMBER")
                      }
                      className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="MEMBER">Member</option>
                    </select>
                    <p className="mt-1 text-xs text-muted">
                      Admin writes campaigns over the REST API, member reads
                      only. A key never carries more access than your own role.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  <button
                    type="submit"
                    disabled={busy === "create"}
                    className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                  >
                    {busy === "create" ? "Creating..." : "Create key"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormOpen(false)}
                    className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setFormOpen(true)}
                  className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
                >
                  Create key
                </button>
              </div>
            )
          ) : (
            <p className="border-t border-border pt-4 text-xs text-muted">
              Only owners and admins can create or revoke API keys.
            </p>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      )}
    </section>
  );
}
