"use client";

/**
 * The portal.
 *
 * Greeting and the overnight sentence, five KPIs, the live board, then the
 * three-up detail row. Everything deeper lives one click away behind a View
 * all link rather than being dumped here.
 *
 * All figures come from one shared fetch of /api/portal/summary, so the nav
 * badges, this page and the right rail cannot disagree with each other.
 */

import Link from "next/link";
import AccountSelect from "@/components/account-select";
import { usePortal } from "@/components/portal/portal-context";
import KpiCard, { type KpiTone } from "@/components/portal/kpi-card";
import LiveBoard, { type BoardLane } from "@/components/portal/live-board";
import StatusBadge from "@/components/status-badge";

function Skeleton(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="h-12 w-80 max-w-full rounded bg-surface-hover" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[...Array(5)].map((_, index) => (
          <div key={index} className="h-32 rounded-lg bg-surface-hover" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-surface-hover" />
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Token expiry is a future date, so it needs its own phrasing. Reusing the
 * past-tense helper above would render a perfectly healthy token as
 * "expired 45d ago".
 */
function expiryLabel(iso: string): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const days = Math.round((target - Date.now()) / 86_400_000);
  if (days < 0) return "token expired";
  if (days === 0) return "token expires today";
  return `token expires in ${days}d`;
}

export default function PortalPage(): React.JSX.Element {
  const { summary, loading, error, accountId, setAccountId } = usePortal();

  if (loading && !summary) return <Skeleton />;

  if (error && !summary) {
    return (
      <div className="panel rounded-lg p-8 text-center">
        <p className="text-sm font-medium text-foreground">{error}</p>
        <p className="mt-1 text-sm text-muted">
          The portal could not load. Your campaigns are unaffected.
        </p>
      </div>
    );
  }

  if (!summary) return <Skeleton />;

  const { greeting, kpis, board, panels } = summary;

  const kpiCards: Array<{ key: string; tone: KpiTone }> = [
    { key: "dmsDelivered", tone: "neutral" },
    { key: "needsAttention", tone: "risk" },
    { key: "capacityUsed", tone: "neutral" },
    { key: "systemHealth", tone: "good" },
    { key: "clickRate", tone: "neutral" },
  ];

  const lanes: BoardLane[] = [
    {
      key: "live",
      title: "Live campaigns",
      count: board.live.count,
      rows: board.live.rows,
      href: "/campaigns",
      emptyLabel: "No campaigns are live yet.",
    },
    {
      key: "inFlight",
      title: "In flight",
      count: board.inFlight.count,
      rows: board.inFlight.rows,
      href: "/logs",
      emptyLabel: "Nothing waiting to send.",
    },
    {
      key: "needsAttention",
      title: "Needs attention",
      count: board.needsAttention.count,
      rows: board.needsAttention.rows,
      href: "/logs?status=FAILED",
      emptyLabel: "Every send landed.",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Greeting and the overnight sentence */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">
            {greeting.userName
              ? `Good to see you, ${greeting.userName}.`
              : "Good to see you."}
          </h2>
          <p className="mt-1 text-sm text-muted">{greeting.overnight}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {panels.accounts.length > 1 && (
            <AccountSelect
              accounts={panels.accounts}
              value={accountId}
              onChange={setAccountId}
            />
          )}
          <Link
            href="/campaigns/new"
            className="whitespace-nowrap rounded bg-accent px-3.5 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            New campaign
          </Link>
        </div>
      </div>

      {/* Five KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {kpiCards.map(({ key, tone }) => {
          const kpi = kpis[key as keyof typeof kpis];
          if (!kpi) return null;
          return (
            <KpiCard
              key={key}
              label={kpi.label}
              value={kpi.value}
              comparison={kpi.comparison}
              series={kpi.series}
              tone={
                key === "needsAttention" && kpi.value === "0" ? "neutral" : tone
              }
            />
          );
        })}
      </div>

      {/* The live board */}
      <LiveBoard lanes={lanes} />

      {/* Three-up detail row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="panel rounded-lg p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Recent activity
          </h3>
          {panels.recentActivity.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">
              No sends yet.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {panels.recentActivity.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      @{row.commenterName ?? "unknown"}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {row.campaignName} {relativeTime(row.createdAt)}
                    </p>
                  </div>
                  <StatusBadge status={row.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel rounded-lg p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            This month
          </h3>
          <dl className="space-y-2">
            {[
              ["Sent", panels.performance.sent.toLocaleString()],
              ["Failed", panels.performance.failed.toLocaleString()],
              ["Skipped", panels.performance.skipped.toLocaleString()],
              ["Clicks", panels.performance.clicks.toLocaleString()],
              ["Click rate", `${panels.performance.clickRate}%`],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {panels.performance.topKeywords.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Top keywords
              </p>
              <ul className="space-y-1.5">
                {panels.performance.topKeywords.map((keyword) => (
                  <li
                    key={keyword.keyword}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="truncate text-xs text-foreground">
                      {keyword.keyword}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {keyword.count}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel rounded-lg p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Connected accounts
          </h3>
          {panels.accounts.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-xs text-muted">No account connected yet.</p>
              <a
                href="/api/instagram/connect"
                className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
              >
                Connect Instagram
              </a>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {panels.accounts.map((account) => (
                <li key={account.id}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm text-foreground">
                      @{account.username}
                    </p>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                      {account.dmsLast7Days}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted">
                    {account.webhookSubscribed
                      ? "Webhook active"
                      : "Webhook not subscribed"}
                    {account.tokenExpiresAt
                      ? `, ${expiryLabel(account.tokenExpiresAt)}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
