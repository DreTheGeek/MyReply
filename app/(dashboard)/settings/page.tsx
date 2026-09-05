"use client";

import AuditLogSection from "@/components/settings/audit-log-section";
import ExportSection from "@/components/settings/export-section";
import QuietHoursSection from "@/components/settings/quiet-hours-section";
import { Suspense, useEffect, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import { InstagramConnectNotice } from "@/components/instagram-connect-notice";
import AiKeySection from "@/components/settings/ai-key-section";
import ApiKeysSection from "@/components/settings/api-keys-section";
import PersistentMenuSection from "@/components/settings/persistent-menu-section";
import KnowledgeSection from "@/components/settings/knowledge-section";
import AnsweringSection from "@/components/settings/answering-section";

interface SettingsData {
  workspace: {
    name: string;
    dmsSentThisPeriod: number;
  };
  instagramAccount: {
    id: string;
    username: string;
    instagramId: string;
    tokenExpiresAt: string | null;
    webhookSubscribed: boolean;
  } | null;
  instagramAccounts: Array<
    AccountOption & {
      tokenExpiresAt: string | null;
      webhookSubscribed: boolean;
    }
  >;
}

/**
 * One editable conversation starter row. The id is local to this editor: Meta
 * stores the set positionally, so rows need a stable key of our own to keep
 * inputs from remounting when a row above them is removed.
 */
interface StarterRow {
  id: string;
  question: string;
  payload: string;
}

let starterRowCounter = 0;

function newStarterRow(question = "", payload = ""): StarterRow {
  starterRowCounter += 1;
  return { id: `starter_${starterRowCounter}`, question, payload };
}

// Instagram's own ceiling, mirrored by the API route.
const MAX_STARTERS = 4;
const MAX_STARTER_QUESTION = 80;
const MAX_STARTER_PAYLOAD = 1000;

interface WorkspaceMembersData {
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER";
  members: Array<{
    id: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: string;
    user: {
      id: string;
      email: string | null;
      name: string | null;
    };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    inviteUrl: string;
    expiresAt: string;
  }>;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersData | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [starterAccountId, setStarterAccountId] = useState<string | null>(null);
  const [starters, setStarters] = useState<StarterRow[]>([]);
  const [startersReadable, setStartersReadable] = useState(true);
  const [starterError, setStarterError] = useState<string | null>(null);
  const [starterNotice, setStarterNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard/stats").then((res) => res.json()),
      fetch("/api/workspace/members").then((res) => res.json()),
    ])
      .then(([statsPayload, membersPayload]) => {
        if (statsPayload.success) {
          setData(statsPayload.data);
          setStarterAccountId(
            statsPayload.data.instagramAccounts?.[0]?.id ?? null
          );
          setLoadError(null);
        } else {
          setLoadError(
            statsPayload.error ?? "We could not load your workspace settings."
          );
        }
        if (membersPayload.success) setMembersData(membersPayload.data);
      })
      // Without a catch this rejected unhandled and left data null, and every
      // read below is data?.x with a fallback, so a working connected account
      // was reported as "Not connected" with an invitation to reconnect it.
      .catch(() => {
        setLoadError("We could not reach the server to load your settings.");
      })
      .finally(() => setLoading(false));
  }, []);

  // Starters live on the Instagram profile, not in our database, so they are
  // loaded per account rather than coming down with the dashboard stats.
  useEffect(() => {
    if (!starterAccountId) return;

    let cancelled = false;
    setStarterError(null);
    setStarterNotice(null);

    fetch(
      `/api/instagram/conversation-starters?instagramAccountId=${encodeURIComponent(
        starterAccountId
      )}`
    )
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return;
        if (!payload.success) {
          setStarterError(payload.error ?? "Could not load conversation starters");
          return;
        }
        setStarters(
          (payload.data.starters as Array<{ question: string; payload: string }>)
            .slice(0, MAX_STARTERS)
            .map((starter) => newStarterRow(starter.question, starter.payload))
        );
        setStartersReadable(Boolean(payload.data.readable));
      })
      .catch(() => {
        if (!cancelled) {
          setStarterError("Could not load conversation starters");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [starterAccountId]);

  async function refreshMembers() {
    const res = await fetch("/api/workspace/members");
    const payload = await res.json();
    if (payload.success) setMembersData(payload.data);
  }

  async function disconnectInstagram(instagramAccountId: string) {
    if (!confirm("Disconnect Instagram? Campaigns for this account will stop sending DMs.")) {
      return;
    }

    setBusy(`disconnect:${instagramAccountId}`);
    try {
      const res = await fetch("/api/instagram/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        // It used to reload regardless, so a member hitting the role gate
        // confirmed the dialog, watched the page reload, and found the account
        // still connected with nothing explaining why.
        setLoadError(payload?.error ?? "We could not disconnect that account.");
        setBusy(null);
        return;
      }
      window.location.reload();
    } catch {
      setLoadError("We could not reach the server to disconnect that account.");
      setBusy(null);
    }
  }

  function updateStarter(
    id: string,
    field: "question" | "payload",
    value: string
  ) {
    setStarters((rows) =>
      rows.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
  }

  async function saveStarters() {
    if (!starterAccountId) return;

    const cleaned = starters
      .map((row) => ({
        question: row.question.trim(),
        payload: row.payload.trim(),
      }))
      .filter((row) => row.question.length > 0 || row.payload.length > 0);

    if (cleaned.length === 0) {
      setStarterError("Add at least one starter, or clear them all.");
      return;
    }
    if (cleaned.some((row) => !row.question || !row.payload)) {
      setStarterError("Every starter needs both a question and a payload.");
      return;
    }

    setStarterError(null);
    setStarterNotice(null);
    setBusy("starters:save");

    // setBusy(null) used to be the last statement rather than a finally, so a
    // network rejection skipped it and left the button disabled on "Saving..."
    // until a reload. Four other settings sections already got this right.
    try {
      const res = await fetch("/api/instagram/conversation-starters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: starterAccountId,
          starters: cleaned,
        }),
      });
      const payload = await res.json();

      if (payload.success) {
        setStarters(
          cleaned.map((row) => newStarterRow(row.question, row.payload))
        );
        setStartersReadable(true);
        setStarterNotice("Saved. Instagram shows these on new conversations.");
      } else {
        setStarterError(payload.error ?? "Could not save conversation starters");
      }
    } catch {
      setStarterError("We could not reach the server. Nothing was saved.");
    } finally {
      setBusy(null);
    }
  }

  async function clearStarters() {
    if (!starterAccountId) return;
    if (
      !confirm(
        "Remove every conversation starter? New DM threads will open with no prompts."
      )
    ) {
      return;
    }

    setStarterError(null);
    setStarterNotice(null);
    setBusy("starters:clear");

    try {
      const res = await fetch("/api/instagram/conversation-starters", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: starterAccountId }),
      });
      const payload = await res.json();

      if (payload.success) {
        setStarters([]);
        setStarterNotice("Cleared. New threads open with no prompts.");
      } else {
        setStarterError(payload.error ?? "Could not clear conversation starters");
      }
    } catch {
      setStarterError("We could not reach the server. Nothing was cleared.");
    } finally {
      setBusy(null);
    }
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setMemberError(null);
    setBusy("invite");
    try {
      const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const payload = await res.json();
      if (payload.success) {
        setMembersData(payload.data);
        setInviteEmail("");
      } else {
        setMemberError(payload.error ?? "Could not invite member");
      }
    } catch {
      setMemberError("We could not reach the server. No invitation was sent.");
    } finally {
      setBusy(null);
    }
  }

  async function removeInvitation(invitationId: string) {
    setBusy(`invite:${invitationId}`);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        setMemberError(payload?.error ?? "Could not revoke that invitation.");
        return;
      }
      await refreshMembers();
    } catch {
      setMemberError("We could not reach the server to revoke it.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="panel rounded p-8 h-64" />;
  }

  const accounts = data?.instagramAccounts ?? [];
  const canManageMembers =
    membersData?.currentUserRole === "OWNER" ||
    membersData?.currentUserRole === "ADMIN";
  // The conversation-starters API applies the same owner-or-admin gate, so the
  // editor is read-only for members rather than failing on save.
  const canManageStarters = canManageMembers;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Surfaces the ?instagram= code the OAuth routes redirect back with.
          Needs a Suspense boundary: useSearchParams in a prerendered client
          page fails the production build without one. */}
      <Suspense fallback={null}>
        <InstagramConnectNotice />
      </Suspense>

      {/* Say the settings could not be read, rather than letting every
          data?.x fallback below describe a healthy workspace as empty and
          disconnected. */}
      {loadError && (
        <div className="rounded border border-error/30 bg-error/5 p-4 text-sm">
          <p className="font-medium text-error">Could not load settings</p>
          <p className="mt-1 text-muted">
            {loadError} What you see below may be incomplete, so avoid changing
            anything until this loads.
          </p>
        </div>
      )}

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Instagram Connection</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 py-3 border-b border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Status</p>
              <p className="text-xs text-muted mt-0.5">
                Comment webhooks and private replies depend on this connection.
              </p>
            </div>
            <span
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                accounts.length > 0
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning"
              }`}
            >
              {accounts.length > 0 ? "Connected" : "Not connected"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 py-3 border-b border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Accounts</p>
              <p className="text-xs text-muted mt-0.5">
                {accounts.length} connected Instagram profile
                {accounts.length === 1 ? "" : "s"}
              </p>
            </div>
            <span className="text-sm text-muted">
              {accounts.length > 0 ? `${accounts.length} connected` : "None"}
            </span>
          </div>

          <div className="space-y-3 py-3">
            {accounts.length === 0 && (
              <p className="text-sm text-muted">
                Connect an Instagram professional account to launch campaigns.
              </p>
            )}
            {accounts.map((account) => (
              <div
                key={account.id}
                className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    @{account.username}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Token expires{" "}
                    {account.tokenExpiresAt
                      ? new Date(account.tokenExpiresAt).toLocaleDateString()
                      : "not available"}{" "}
                    · {account.webhookSubscribed ? "Webhook ready" : "Webhook pending"}
                  </p>
                </div>
                <button
                  onClick={() => disconnectInstagram(account.id)}
                  disabled={busy === `disconnect:${account.id}`}
                  className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
                >
                  {busy === `disconnect:${account.id}`
                    ? "Disconnecting..."
                    : "Disconnect"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-border flex gap-3">
          <a
            href="/api/instagram/connect"
            className="px-4 py-2 rounded text-sm font-medium transition-colors bg-accent text-on-accent hover:bg-accent-hover"
          >
            {accounts.length > 0 ? "Connect another account" : "Connect Instagram"}
          </a>
        </div>
      </section>

      <QuietHoursSection />

      <ExportSection />

      <AuditLogSection />

      <section id="conversation-starters" className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-2">Conversation starters</h2>
        <p className="text-xs text-muted mb-6">
          Tappable prompts Instagram shows someone opening a fresh DM thread with
          you. Instagram displays at most {MAX_STARTERS}, and saving replaces the
          whole set. The payload is what your automations receive when the prompt
          is tapped, so use the campaign keyword.
        </p>

        {accounts.length === 0 ? (
          <p className="text-sm text-muted">
            Connect an Instagram professional account to set conversation
            starters.
          </p>
        ) : (
          <div className="space-y-4">
            {accounts.length > 1 && (
              <div>
                <label
                  htmlFor="starter-account"
                  className="mb-1.5 block text-xs font-medium text-muted"
                >
                  Account
                </label>
                <select
                  id="starter-account"
                  value={starterAccountId ?? ""}
                  onChange={(event) => setStarterAccountId(event.target.value)}
                  className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      @{account.username}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!startersReadable && (
              <p className="rounded border border-border bg-surface/70 p-3 text-xs text-muted">
                Instagram does not report the prompts already live on this
                account, so this list starts empty. Saving still replaces
                whatever is there.
              </p>
            )}

            {starters.length === 0 && (
              <p className="text-sm text-muted">No starters set up yet.</p>
            )}

            {starters.map((row, index) => (
              <div
                key={row.id}
                className="space-y-3 rounded border border-border bg-surface/70 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-muted">
                    Prompt {index + 1}
                  </span>
                  {canManageStarters && (
                    <button
                      type="button"
                      onClick={() =>
                        setStarters((rows) =>
                          rows.filter((existing) => existing.id !== row.id)
                        )
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div>
                  <input
                    type="text"
                    value={row.question}
                    onChange={(event) =>
                      updateStarter(row.id, "question", event.target.value)
                    }
                    disabled={!canManageStarters}
                    maxLength={MAX_STARTER_QUESTION}
                    placeholder="Send me the free guide"
                    className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
                  />
                  <p className="mt-1 text-xs text-muted">
                    What the person taps. {row.question.length} of{" "}
                    {MAX_STARTER_QUESTION} characters.
                  </p>
                </div>

                <div>
                  <input
                    type="text"
                    value={row.payload}
                    onChange={(event) =>
                      updateStarter(row.id, "payload", event.target.value)
                    }
                    disabled={!canManageStarters}
                    maxLength={MAX_STARTER_PAYLOAD}
                    placeholder="GUIDE"
                    className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Payload sent back to your automations on tap.
                  </p>
                </div>
              </div>
            ))}

            {canManageStarters ? (
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() =>
                    setStarters((rows) => [...rows, newStarterRow()])
                  }
                  disabled={starters.length >= MAX_STARTERS}
                  className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
                >
                  {starters.length >= MAX_STARTERS
                    ? `${MAX_STARTERS} is the Instagram limit`
                    : "Add starter"}
                </button>
                <button
                  type="button"
                  onClick={saveStarters}
                  disabled={busy === "starters:save"}
                  className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {busy === "starters:save" ? "Saving..." : "Save starters"}
                </button>
                <button
                  type="button"
                  onClick={clearStarters}
                  disabled={busy === "starters:clear"}
                  className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
                >
                  {busy === "starters:clear" ? "Clearing..." : "Clear all"}
                </button>
              </div>
            ) : (
              <p className="border-t border-border pt-4 text-xs text-muted">
                Only owners and admins can change conversation starters.
              </p>
            )}

            {starterError && (
              <p className="text-sm text-error">{starterError}</p>
            )}
            {starterNotice && (
              <p className="text-sm text-muted">{starterNotice}</p>
            )}
          </div>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Team</h2>
        <div className="space-y-3">
          {membersData?.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {member.user.name ?? member.user.email ?? "Unknown member"}
                </p>
                <p className="text-xs text-muted">{member.user.email}</p>
              </div>
              <span className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted">
                {member.role}
              </span>
            </div>
          ))}
        </div>

        {membersData?.invitations.length ? (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Pending invites
            </p>
            <div className="space-y-3">
              {membersData.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invitation.email}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {invitation.role} · {invitation.inviteUrl}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(invitation.inviteUrl)
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => removeInvitation(invitation.id)}
                      disabled={busy === `invite:${invitation.id}`}
                      className="rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManageMembers && (
          <form
            onSubmit={inviteMember}
            className="mt-6 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_140px_auto]"
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@agency.com"
              className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
              required
            />
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "ADMIN" | "MEMBER")
              }
              className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={busy === "invite"}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "invite" ? "Inviting..." : "Invite"}
            </button>
            {memberError && (
              <p className="sm:col-span-3 text-sm text-error">{memberError}</p>
            )}
          </form>
        )}
      </section>

      <PersistentMenuSection
        accounts={data?.instagramAccounts ?? []}
        currentUserRole={membersData?.currentUserRole ?? null}
      />

      <KnowledgeSection currentUserRole={membersData?.currentUserRole ?? null} />

      <AnsweringSection currentUserRole={membersData?.currentUserRole ?? null} />

      <section id="ai-key" className="panel rounded p-4 sm:p-6">
        <AiKeySection />
      </section>

      <section id="api-keys" className="panel rounded p-4 sm:p-6">
        <ApiKeysSection currentUserRole={membersData?.currentUserRole ?? null} />
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Usage</h2>
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              DMs sent this month
            </p>
            <p className="text-xs text-muted mt-0.5">
              Free plan, one connected account.
            </p>
          </div>
          <span className="text-sm font-semibold text-foreground">
            {data?.workspace.dmsSentThisPeriod ?? 0}
          </span>
        </div>
      </section>
    </div>
  );
}
