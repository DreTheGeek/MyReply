/**
 * Not at 3am.
 *
 * WHAT THIS GATES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * A campaign's first reply is never gated. Someone commented asking for the
 * link; the whole promise of the product is that they get it in seconds. Making
 * them wait until 8am because it is late where the account owner lives would
 * break the thing they are paying for, and the person is awake, because they
 * just commented.
 *
 * The follow-up is different. It fires on a delay the recipient did not ask
 * for and is not waiting on, which is exactly the message that lands at 3am and
 * reads as spam. That is what this holds.
 *
 * WHOSE CLOCK. The workspace's, because it is the closest proxy the data has
 * for the audience's. An Instagram account's followers cluster around the
 * account's own hours, and it is the only timezone the owner ever sets or sees.
 *
 * WHY Intl AND NOT AN OFFSET. An IANA zone carries its own DST rules. Storing
 * "-5" means being an hour wrong for half the year, in the direction that sends
 * at 6am instead of 7am.
 */

export interface QuietHoursConfig {
  /** IANA zone, for example "America/New_York". */
  timezone: string;
  quietHoursEnabled: boolean;
  /** Local hour quiet begins, 0-23. */
  quietHoursStart: number;
  /** Local hour quiet ends, 0-23. */
  quietHoursEnd: number;
}

/**
 * The wall-clock hour in a zone, 0-23.
 *
 * Returns null when the zone is not one Intl recognises. A bad timezone must
 * never take the worker down or, worse, silently hold every follow-up forever:
 * callers treat null as "cannot tell, so do not gate".
 */
export function localHour(instant: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
    }).formatToParts(instant);

    const hour = parts.find((part) => part.type === "hour")?.value;
    if (hour === undefined) return null;

    const parsed = Number(hour);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23
      ? parsed
      : null;
  } catch {
    // RangeError from an unknown zone.
    return null;
  }
}

/**
 * Is this local hour inside the quiet window?
 *
 * Windows wrap midnight, and the common one does: 21 to 9. Handling that with
 * a single `>= start && < end` is the bug this exists to avoid, because it
 * silently means "never quiet" for every wrapping window.
 *
 * start === end is read as "no quiet hours" rather than "always quiet". The
 * alternative bricks every follow-up on a single mistyped field.
 */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export interface QuietHoursVerdict {
  /** True when the message must be held. */
  quiet: boolean;
  /** The workspace-local hour used to decide, or null when it was unreadable. */
  localHour: number | null;
  /** Milliseconds until the window opens. Zero when not quiet. */
  retryAfterMs: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether a follow-up may send right now, and if not, when to try again.
 *
 * The delay is deliberately rounded up to the top of the hour the window opens
 * rather than computed to the minute. Precision here buys nothing, and a
 * whole-hour delay keeps requeue times legible in the logs.
 */
export function checkQuietHours(
  config: QuietHoursConfig,
  now: Date = new Date()
): QuietHoursVerdict {
  if (!config.quietHoursEnabled) {
    return { quiet: false, localHour: null, retryAfterMs: 0 };
  }

  const hour = localHour(now, config.timezone);
  if (hour === null) {
    // Unreadable zone. Send rather than hold: a stuck follow-up is a silent
    // failure, and this is a courtesy feature, not a safety one.
    return { quiet: false, localHour: null, retryAfterMs: 0 };
  }

  if (!isQuietHour(hour, config.quietHoursStart, config.quietHoursEnd)) {
    return { quiet: false, localHour: hour, retryAfterMs: 0 };
  }

  // Hours from now until the window opens, walking forward so a wrapping
  // window needs no separate arithmetic.
  let hoursUntilOpen = 0;
  let cursor = hour;
  while (
    isQuietHour(cursor, config.quietHoursStart, config.quietHoursEnd) &&
    hoursUntilOpen < 24
  ) {
    cursor = (cursor + 1) % 24;
    hoursUntilOpen += 1;
  }

  // Subtract the minutes already elapsed in the current hour, so a message
  // held at 20:58 waits two minutes rather than a full hour.
  const elapsedInHour =
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1000 +
    now.getUTCMilliseconds();

  return {
    quiet: true,
    localHour: hour,
    retryAfterMs: Math.max(1000, hoursUntilOpen * HOUR_MS - elapsedInHour),
  };
}

/** True when Intl recognises the zone, for validating what a user typed. */
export function isValidTimezone(timezone: string): boolean {
  return localHour(new Date(), timezone) !== null;
}
