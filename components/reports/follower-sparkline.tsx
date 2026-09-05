/**
 * Follower total over the reporting window, as an inline SVG.
 *
 * A server component with no charting dependency, deliberately. This renders
 * on a public report an agency sends to a client, opened once, usually on a
 * phone, often on a bad connection. Pulling a charting runtime onto that page
 * to draw one line would cost more than everything else on it combined.
 *
 * The shape is the message. Exact daily values are not the point and are not
 * labelled; the endpoints and the net change are, and those are text.
 */

export interface FollowerPoint {
  date: string;
  followers: number;
}

const WIDTH = 720;
const HEIGHT = 120;
const PADDING = 4;

function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function FollowerSparkline({
  points,
}: {
  points: FollowerPoint[];
}): React.JSX.Element | null {
  if (points.length < 2) return null;

  const values = points.map((point) => point.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat line still has to be a line rather than a division by zero, and it
  // should sit in the middle of the box rather than on the floor.
  const span = max - min || 1;

  const coords = points.map((point, index) => {
    const x = PADDING + (index / (points.length - 1)) * (WIDTH - PADDING * 2);
    const y =
      HEIGHT -
      PADDING -
      ((point.followers - min) / span) * (HEIGHT - PADDING * 2);
    return { x, y };
  });

  const line = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");

  // Closed back along the baseline so the area under the line can be filled.
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${HEIGHT} L${coords[0].x.toFixed(1)},${HEIGHT} Z`;

  const first = points[0];
  const last = points[points.length - 1];
  const rising = last.followers >= first.followers;
  const stroke = rising ? "#34d399" : "#fb7185";

  return (
    <figure className="mt-6">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={`Followers went from ${first.followers.toLocaleString()} on ${formatDay(first.date)} to ${last.followers.toLocaleString()} on ${formatDay(last.date)}.`}
      >
        <defs>
          <linearGradient id="follower-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#follower-fill)" />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption className="mt-3 flex items-baseline justify-between text-xs text-zinc-500">
        <span>
          {formatDay(first.date)} &middot;{" "}
          <span className="text-zinc-300">
            {first.followers.toLocaleString()}
          </span>
        </span>
        <span>
          {formatDay(last.date)} &middot;{" "}
          <span className="text-zinc-300">
            {last.followers.toLocaleString()}
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
