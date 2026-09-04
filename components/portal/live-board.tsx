"use client";

/**
 * The live board: the operational heart of the portal.
 *
 * Lanes map to the real comment-to-DM workflow rather than to database tables:
 * what is running, what is moving through the queue right now, and what has
 * stopped and needs a person. Each lane carries its true count so the footer
 * can be honest about how much is not shown.
 */

import Link from "next/link";
import type { BoardRow, BoardTone } from "@/lib/portal/types";

export interface BoardLane {
  key: string;
  title: string;
  /** True total, which can exceed rows.length. */
  count: number;
  rows: BoardRow[];
  href: string;
  emptyLabel: string;
}

const PILL: Record<BoardTone, string> = {
  neutral: "border-border text-muted",
  good: "border-success/40 text-success",
  risk: "border-error/40 text-error",
  pending: "border-warning/40 text-warning",
};

export default function LiveBoard({
  lanes,
}: {
  lanes: BoardLane[];
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.35fr_1fr_1fr]">
      {lanes.map((lane) => (
        <section
          key={lane.key}
          className="panel flex min-w-0 flex-col rounded-lg"
          aria-label={lane.title}
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {lane.title}
            </h3>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
              {lane.count}
            </span>
          </header>

          <div className="min-h-0 flex-1">
            {lane.rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted">
                {lane.emptyLabel}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {lane.rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {row.primary}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {row.secondary}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PILL[row.tone]}`}
                    >
                      {row.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <footer className="border-t border-border px-4 py-2.5">
            <Link
              href={lane.href}
              className="text-xs font-medium text-accent hover:underline"
            >
              {lane.count > lane.rows.length
                ? `View all ${lane.count}`
                : "View all"}
            </Link>
          </footer>
        </section>
      ))}
    </div>
  );
}
