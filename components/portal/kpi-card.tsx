"use client";

/**
 * One KPI card for the portal's five-card row.
 *
 * Uppercase micro-label, one big figure, a one-line comparison to the previous
 * period, and a sparkline. The tone prop lifts the at-risk card to the error
 * colour, which is the only card allowed to shout.
 */

export type KpiTone = "neutral" | "risk" | "good";

export interface KpiCardProps {
  label: string;
  value: string;
  /** One line comparing to the previous equal period. Null when there is no prior period. */
  comparison: string | null;
  /** Daily points, oldest first. Fewer than two points renders no line. */
  series: number[];
  tone?: KpiTone;
}

const TONE_TEXT: Record<KpiTone, string> = {
  neutral: "text-foreground",
  risk: "text-error",
  good: "text-success",
};

const TONE_STROKE: Record<KpiTone, string> = {
  neutral: "var(--color-accent)",
  risk: "var(--color-error)",
  good: "var(--color-success)",
};

/**
 * Maps the series into a 100x28 box. A flat series would divide by zero on
 * range, so it is pinned to the middle instead.
 */
function buildPath(series: number[]): string | null {
  if (series.length < 2) return null;

  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min;
  const step = 100 / (series.length - 1);

  return series
    .map((point, index) => {
      const x = index * step;
      const y = range === 0 ? 14 : 26 - ((point - min) / range) * 24;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function KpiCard({
  label,
  value,
  comparison,
  series,
  tone = "neutral",
}: KpiCardProps): React.JSX.Element {
  const path = buildPath(series);

  return (
    <div className="panel flex flex-col gap-3 rounded-lg p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </p>

      <p
        className={`font-mono text-2xl font-semibold tabular-nums leading-none ${TONE_TEXT[tone]}`}
      >
        {value}
      </p>

      {path ? (
        <svg
          viewBox="0 0 100 28"
          preserveAspectRatio="none"
          className="h-7 w-full"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d={path}
            fill="none"
            stroke={TONE_STROKE[tone]}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="h-7" />
      )}

      <p className="text-xs text-muted">{comparison ?? "No prior period yet"}</p>
    </div>
  );
}
