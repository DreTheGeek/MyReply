"use client";

/**
 * Portal right rail: what needs you, then the assistant.
 *
 * Triage only. The centre column is for doing work, this rail is for noticing
 * that work is needed.
 *
 * Deviation from the generic standard, deliberately: tasks here are not
 * checkboxes. Every task is derived from live state (a token about to expire,
 * an account with no webhook, a campaign that can never fire), so it clears
 * itself the moment the underlying condition is fixed. A checkbox would let
 * someone tick away a problem that is still real.
 */

import Link from "next/link";
import type {
  AlertLevel,
  RailAlert,
  RailTask,
  RailUsage,
  TaskSeverity,
} from "@/lib/portal/types";

export interface PortalRailProps {
  alerts: RailAlert[];
  alertTotal: number;
  tasks: RailTask[];
  usage: RailUsage | null;
  assistant: React.ReactNode;
  loading: boolean;
}

const ALERT_TEXT: Record<AlertLevel, string> = {
  INFO: "text-muted",
  WARNING: "text-warning",
  ERROR: "text-error",
};

const TASK_DOT: Record<TaskSeverity, string> = {
  info: "bg-muted",
  warning: "bg-warning",
  error: "bg-error",
};

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SectionHeading({
  title,
  count,
}: {
  title: string;
  count?: number;
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </h2>
      {count !== undefined && count > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {count}
        </span>
      )}
    </div>
  );
}

export default function PortalRail({
  alerts,
  alertTotal,
  tasks,
  usage,
  assistant,
  loading,
}: PortalRailProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto border-l border-border bg-surface px-3 py-4">
      <section>
        <SectionHeading title="Alerts" count={alertTotal} />
        {loading ? (
          <div className="h-12 rounded bg-surface-hover" />
        ) : alerts.length === 0 ? (
          <p className="text-xs text-muted">Nothing to report.</p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className="rounded border border-border bg-background px-2.5 py-2"
              >
                <p
                  className={`text-[11px] font-medium leading-snug ${ALERT_TEXT[alert.level]}`}
                >
                  {alert.message}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted">
                  {alert.source.toLowerCase()} {shortTime(alert.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Waiting on you" count={tasks.length} />
        {loading ? (
          <div className="h-12 rounded bg-surface-hover" />
        ) : tasks.length === 0 ? (
          <p className="text-xs text-muted">You are all clear.</p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id}>
                <Link
                  href={task.href}
                  className="flex items-start gap-2 rounded px-1.5 py-1.5 hover:bg-surface-hover"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TASK_DOT[task.severity]}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium leading-snug text-foreground">
                      {task.label}
                    </span>
                    <span className="block text-[10px] leading-snug text-muted">
                      {task.detail}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Usage" />
        {loading || !usage ? (
          <div className="h-12 rounded bg-surface-hover" />
        ) : (
          <div className="rounded border border-border bg-background px-2.5 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted">DMs this period</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {usage.dmsThisPeriod.toLocaleString()}
              </span>
            </div>
            <p className="mt-1.5 font-mono text-[10px] text-muted">
              since {shortTime(usage.periodStart)}
            </p>
            {/* Labelled per the no-hallucination law: this number is the
                billing meter itself, not a second count that could disagree. */}
            <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-success">
              Verified from the meter
            </p>
          </div>
        )}
      </section>

      <section className="mt-auto">{assistant}</section>
    </div>
  );
}
