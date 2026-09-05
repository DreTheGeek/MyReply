"use client";

import { useEffect, useState } from "react";
import StatusBadge from "@/components/status-badge";

interface DiagnosticsData {
  queueCounts: Record<string, number>;
  workerHealth: {
    healthy: boolean;
    ageMs: number | null;
    heartbeat: {
      checkedAt: string;
      hostname?: string;
      pid: number;
      startedAt?: string;
    } | null;
  };
  webhookFailures: Array<{
    id: string;
    object: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  dmFailures: Array<{
    id: string;
    status: string;
    commentId: string;
    commentText: string;
    errorMessage: string | null;
    updatedAt: string;
    automation: { name: string };
  }>;
  tokenRefreshFailures: Array<{
    id: string;
    message: string;
    createdAt: string;
  }>;
  operationalEvents: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function EmptyState({ label }: { label: string }) {
  return <p className="py-5 text-center text-sm text-muted">{label}</p>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function DiagnosticsPage() {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  // Every read below is data?.x with a fallback, so without this the page
  // rendered a complete and entirely invented all-clear whenever the request
  // failed: "Queue waiting 0", "No DM failures or skips", "No failed webhook
  // events". A MEMBER, who gets a 403 from this endpoint and sees the link in
  // the sidebar regardless, saw a full operational report in which every
  // number was a lie.
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/diagnostics");
      const payload = await response.json();
      if (payload.success) {
        setData(payload.data);
        setLoadError(null);
      } else {
        setLoadError(
          response.status === 403
            ? "Diagnostics are limited to workspace owners and admins."
            : (payload.error ?? "Could not load diagnostics.")
        );
      }
    } catch {
      setLoadError("Could not reach the server to load diagnostics.");
    } finally {
      setLoading(false);
    }
  }

  const refreshDiagnostics = load;

  useEffect(() => {
    let active = true;

    async function loadInitialDiagnostics() {
      try {
        const response = await fetch("/api/admin/diagnostics");
        const payload = await response.json();
        if (!active) return;
        if (payload.success) {
          setData(payload.data);
          setLoadError(null);
        } else {
          setLoadError(
            response.status === 403
              ? "Diagnostics are limited to workspace owners and admins."
              : (payload.error ?? "Could not load diagnostics.")
          );
        }
      } catch {
        if (active) {
          setLoadError("Could not reach the server to load diagnostics.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadInitialDiagnostics();

    return () => {
      active = false;
    };
  }, []);

  if (loading && !data) {
    return <div className="panel rounded p-8 h-64" />;
  }

  // No numbers at all beats invented ones.
  if (loadError && !data) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="panel rounded p-8 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            Diagnostics unavailable
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="mt-6 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? "Retrying..." : "Try again"}
          </button>
        </div>
      </div>
    );
  }

  const workerAgeSeconds =
    data?.workerHealth.ageMs == null
      ? null
      : Math.round(data.workerHealth.ageMs / 1000);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Production Diagnostics
          </h1>
          <p className="mt-1 text-sm text-muted">
            Health, queues, webhook failures, billing events, and worker alerts.
          </p>
        </div>
        {/* The loading guard above only fires when there is no data, so with
            data present nothing on screen changed while this ran and the button
            stayed clickable throughout. */}
        <button
          onClick={() => void refreshDiagnostics()}
          disabled={loading}
          className="rounded border border-border bg-surface px-4 py-2 text-sm font-semibold text-foreground transition hover:border-border-hover disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        <div className="panel rounded p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase text-muted">
            Worker health
          </p>
          <p
            className={`mt-3 text-2xl font-bold ${
              data?.workerHealth.healthy ? "text-success" : "text-warning"
            }`}
          >
            {data?.workerHealth.healthy ? "Healthy" : "Needs attention"}
          </p>
          <p className="mt-2 text-xs text-muted">
            {workerAgeSeconds == null
              ? "No heartbeat found"
              : `Last heartbeat ${workerAgeSeconds}s ago`}
          </p>
        </div>
        {["waiting", "active", "delayed", "failed"].map((key) => (
          <div key={key} className="panel rounded p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase text-muted">
              Queue {key}
            </p>
            <p className="mt-3 text-2xl font-bold text-foreground">
              {data?.queueCounts[key] ?? 0}
            </p>
          </div>
        ))}
      </div>


      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Campaign DM Failures And Skips">
          {data?.dmFailures.length ? (
            <div className="space-y-3">
              {data.dmFailures.map((item) => (
                <div key={item.id} className="border-b border-border pb-3 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                      {item.automation.name}
                    </p>
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {item.commentText}
                  </p>
                  {item.errorMessage && (
                    <p className="mt-1 text-xs text-error">{item.errorMessage}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="No DM failures or skips." />
          )}
        </Section>

        <Section title="Webhook Failures">
          {data?.webhookFailures.length ? (
            <div className="space-y-3">
              {data.webhookFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-semibold text-foreground">
                    {event.object ?? "Instagram webhook"}
                  </p>
                  <p className="mt-1 text-xs text-error">
                    {event.errorMessage ?? "Unknown error"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="No failed webhook events." />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Token Refresh Failures">
          {data?.tokenRefreshFailures.length ? (
            <div className="space-y-3">
              {data.tokenRefreshFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-semibold text-foreground">
                    {event.message}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="No token refresh failures." />
          )}
        </Section>

      </div>

      <Section title="Operational Event Timeline">
        {data?.operationalEvents.length ? (
          <div className="space-y-3">
            {data.operationalEvents.map((event) => (
              <div key={event.id} className="grid gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-[140px_1fr_auto]">
                <p className="text-xs font-semibold text-muted">{event.source}</p>
                <p className="text-sm text-foreground">{event.message}</p>
                <p className="text-xs text-muted">{formatDate(event.createdAt)}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="No operational events recorded." />
        )}
      </Section>
    </div>
  );
}
