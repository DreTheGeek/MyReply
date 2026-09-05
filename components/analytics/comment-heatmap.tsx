"use client";

/**
 * When your audience comments, as a 7 x 24 grid.
 *
 * A CSS grid and one background colour per cell. No chart library, which for a
 * heatmap is the correct call rather than a compromise: the whole drawing is
 * 168 divs whose only variable is opacity, and pulling in a charting runtime to
 * produce that would cost more bytes than the rest of the page.
 *
 * Colour carries the value, so the number is also in the title attribute and
 * the legend gives the scale. Anyone reading this with a screen reader gets the
 * summary sentence above the grid, which is the actual finding.
 */

import { Fragment } from "react";

export interface CommentHeatmapProps {
  /** 7 rows Sunday..Saturday, 24 columns 0..23. */
  matrix: number[][];
  timezone: string;
  /** Already-formatted, for example "Tuesday around 7pm". */
  peakLabel: string | null;
  total: number;
  windowDays: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Only every third hour is labelled, or the axis is unreadable on a phone. */
const LABELLED_HOURS = new Set([0, 3, 6, 9, 12, 15, 18, 21]);

function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export default function CommentHeatmap({
  matrix,
  timezone,
  peakLabel,
  total,
  windowDays,
}: CommentHeatmapProps): React.JSX.Element {
  const max = matrix.reduce(
    (best, row) => row.reduce((rowBest, value) => Math.max(rowBest, value), best),
    0
  );

  return (
    <section className="panel rounded p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">
          When your audience comments
        </h2>
        <span className="text-xs text-muted">Last {windowDays} days</span>
      </div>

      {total === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Nothing to plot yet. Once campaigns have seen a few hundred comments,
          this shows the hours your audience is actually active.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            {peakLabel ? (
              <>
                Busiest <span className="text-foreground">{peakLabel}</span>,
                across {total.toLocaleString()} comments. Times are {timezone}.
              </>
            ) : (
              <>
                {total.toLocaleString()} comments. Times are {timezone}.
              </>
            )}
          </p>

          {/* Scrolls in its own container so the page never scrolls sideways
              on a phone. */}
          <div className="mt-4 overflow-x-auto">
            <div
              className="grid min-w-[34rem] gap-px"
              style={{
                gridTemplateColumns: "2.2rem repeat(24, minmax(0.6rem, 1fr))",
              }}
            >
              <div />
              {Array.from({ length: 24 }, (_, hour) => (
                <div
                  key={`h-${hour}`}
                  className="pb-1 text-center text-[9px] text-zinc-500"
                >
                  {LABELLED_HOURS.has(hour) ? hourLabel(hour) : ""}
                </div>
              ))}

              {DAYS.map((day, dayIndex) => (
                <Fragment key={day}>
                  <div className="self-center pr-2 text-right text-[10px] text-muted">
                    {day}
                  </div>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const value = matrix[dayIndex]?.[hour] ?? 0;
                    // Floored so a single comment is still visible rather than
                    // rendering as an empty cell at 1/400th opacity.
                    const intensity =
                      max === 0 || value === 0
                        ? 0
                        : Math.max(0.12, value / max);

                    return (
                      <div
                        key={`${day}-${hour}`}
                        title={`${day} ${hourLabel(hour)} — ${value} comment${value === 1 ? "" : "s"}`}
                        className="h-4 rounded-[1px]"
                        style={{
                          backgroundColor:
                            intensity === 0
                              ? "var(--color-surface-hover)"
                              : `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 100)}%, transparent)`,
                        }}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-zinc-500">
            <span>Less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((step) => (
              <span
                key={step}
                className="h-3 w-3 rounded-[1px]"
                style={{
                  backgroundColor:
                    step === 0
                      ? "var(--color-surface-hover)"
                      : `color-mix(in srgb, var(--color-accent) ${step * 100}%, transparent)`,
                }}
              />
            ))}
            <span>More</span>
          </div>
        </>
      )}
    </section>
  );
}
