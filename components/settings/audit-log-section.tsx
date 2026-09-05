"use client";

/**
 * Who did what.
 *
 * The rows have been written since lib/audit.ts landed and nothing ever read
 * them. Deleting a campaign cascades its DmLog, so it destroys the delivery
 * evidence for every message that campaign ever sent; this is the only record
 * that it happened and who did it.
 */

import { useEffect, useState } from "react";

interface AuditEntry {
  id: string;
  action: string;
  label: string;
  actor: { name: string | null; email: string | null } | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

function actorLabel(actor: AuditEntry["actor"]): string {
  // Three genuinely different states, and collapsing them would be a lie.
  if (!actor) return "An API key";
  if (actor.name || actor.email) return actor.name ?? actor.email ?? "Someone";
  return "A removed teammate";
}

function detailLabel(entry: AuditEntry): string | null {
  const parts: string[] = [];
  if (typeof entry.detail.name === "string") parts.push(entry.detail.name);
  if (typeof entry.detail.dataset === "string") {
    parts.push(String(entry.detail.dataset));
  }
  if (typeof entry.detail.rows === "number") {
    parts.push(`${entry.detail.rows.toLocaleString()} rows`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export default function AuditLogSection(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/workspace/audit")
      .then(async (res) => {
        const payload = await res.json().catch(() => null);
        if (res.status === 403) {
          setError("The audit log is limited to workspace owners and admins.");
          return;
        }
        if (!res.ok || !payload?.success) {
          setError(payload?.error ?? "Could not load the audit log.");
          return;
        }
        setEntries(payload.data.entries);
      })
      .catch(() => setError("Could not reach the server."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold">Audit log</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Every action that destroys something or takes data off the platform.
        Deleting a campaign also deletes the delivery history behind it, so this
        is the record that it happened.
      </p>

      {loading ? (
        <div className="mt-5 h-24 rounded bg-surface-hover" />
      ) : error ? (
        <p className="mt-4 text-sm text-muted">{error}</p>
      ) : !entries || entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          Nothing yet. Deletions, revocations and exports appear here as they
          happen.
        </p>
      ) : (
        <ol className="mt-5 space-y-3">
          {entries.map((entry) => {
            const detail = detailLabel(entry);
            return (
              <li
                key={entry.id}
                className="border-b border-border pb-3 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-sm text-foreground">
                    <span className="font-medium">{actorLabel(entry.actor)}</span>{" "}
                    <span className="text-muted">{entry.label.toLowerCase()}</span>
                  </p>
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 font-mono text-[11px] text-zinc-500"
                  >
                    {entry.createdAt.replace("T", " ").slice(0, 16)} UTC
                  </time>
                </div>
                {detail && (
                  <p className="mt-0.5 text-xs text-muted">{detail}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
