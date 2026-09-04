"use client";

interface ContactTagChipProps {
  name: string;
  color?: string | null;
}

/**
 * A single tag pill. The swatch carries the tag colour when one is set and
 * falls back to the accent token when it is not, so an untagged colour never
 * renders as a hole in the row.
 */
export default function ContactTagChip({ name, color }: ContactTagChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-foreground">
      <span
        className="h-1.5 w-1.5 rounded-full bg-accent"
        style={color ? { background: color } : undefined}
      />
      {name}
    </span>
  );
}
