import { describe, expect, it } from "vitest";

import {
  checkQuietHours,
  isQuietHour,
  isValidTimezone,
  localHour,
} from "../lib/messaging/quiet-hours";

const NEW_YORK = "America/New_York";

describe("isQuietHour", () => {
  // The window that matters, and the one a naive `>= start && < end` gets
  // exactly backwards: it would report "never quiet" for every hour.
  it("handles a window that wraps midnight", () => {
    const quiet = (h: number) => isQuietHour(h, 21, 9);

    expect(quiet(22)).toBe(true);
    expect(quiet(3)).toBe(true);
    expect(quiet(8)).toBe(true);
    expect(quiet(9)).toBe(false);
    expect(quiet(14)).toBe(false);
    expect(quiet(20)).toBe(false);
    expect(quiet(21)).toBe(true);
  });

  it("handles a window inside one day", () => {
    const quiet = (h: number) => isQuietHour(h, 2, 6);

    expect(quiet(1)).toBe(false);
    expect(quiet(2)).toBe(true);
    expect(quiet(5)).toBe(true);
    expect(quiet(6)).toBe(false);
  });

  // Reading this as "always quiet" would brick every follow-up in the
  // workspace on one mistyped field, with no error anywhere.
  it("reads an empty window as no quiet hours, never as always quiet", () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(isQuietHour(hour, 9, 9)).toBe(false);
    }
  });
});

describe("localHour", () => {
  it("reads the wall-clock hour in the given zone", () => {
    // 2026-01-15T18:30:00Z is 13:30 in New York (UTC-5 in January).
    const winter = new Date("2026-01-15T18:30:00Z");
    expect(localHour(winter, NEW_YORK)).toBe(13);
    expect(localHour(winter, "UTC")).toBe(18);
  });

  // The reason this uses Intl and an IANA zone rather than a stored offset.
  it("follows daylight saving without being told about it", () => {
    const winter = new Date("2026-01-15T18:30:00Z");
    const summer = new Date("2026-07-15T18:30:00Z");

    expect(localHour(winter, NEW_YORK)).toBe(13);
    expect(localHour(summer, NEW_YORK)).toBe(14);
  });

  it("returns null for a zone Intl does not know", () => {
    expect(localHour(new Date(), "Mars/Olympus_Mons")).toBeNull();
    expect(localHour(new Date(), "")).toBeNull();
    expect(localHour(new Date(), "-5")).toBeNull();
  });

  it("reads midnight as 0 rather than 24", () => {
    expect(localHour(new Date("2026-01-15T00:30:00Z"), "UTC")).toBe(0);
  });
});

describe("checkQuietHours", () => {
  const config = {
    timezone: NEW_YORK,
    quietHoursEnabled: true,
    quietHoursStart: 21,
    quietHoursEnd: 9,
  };

  it("holds a follow-up in the middle of the night", () => {
    // 07:30 UTC is 02:30 in New York.
    const verdict = checkQuietHours(config, new Date("2026-01-16T07:30:00Z"));

    expect(verdict.quiet).toBe(true);
    expect(verdict.localHour).toBe(2);
    // 02:30 to 09:00 is six and a half hours.
    expect(verdict.retryAfterMs).toBe(6.5 * 60 * 60 * 1000);
  });

  it("lets a follow-up through in the afternoon", () => {
    const verdict = checkQuietHours(config, new Date("2026-01-15T18:30:00Z"));

    expect(verdict.quiet).toBe(false);
    expect(verdict.retryAfterMs).toBe(0);
  });

  it("waits minutes, not an hour, when the window is about to open", () => {
    // 13:58 UTC is 08:58 in New York, two minutes before the window opens.
    const verdict = checkQuietHours(config, new Date("2026-01-15T13:58:00Z"));

    expect(verdict.quiet).toBe(true);
    expect(verdict.retryAfterMs).toBe(2 * 60 * 1000);
  });

  it("sends when quiet hours are switched off", () => {
    const verdict = checkQuietHours(
      { ...config, quietHoursEnabled: false },
      new Date("2026-01-16T07:30:00Z")
    );

    expect(verdict.quiet).toBe(false);
  });

  // A held message is a silent failure. This is a courtesy feature, not a
  // safety one, so an unreadable zone must fail open.
  it("sends rather than holds when the timezone is unreadable", () => {
    const verdict = checkQuietHours(
      { ...config, timezone: "Not/AZone" },
      new Date("2026-01-16T07:30:00Z")
    );

    expect(verdict.quiet).toBe(false);
    expect(verdict.localHour).toBeNull();
  });

  it("never returns a zero or negative delay while quiet", () => {
    for (let minute = 0; minute < 60; minute += 7) {
      const at = new Date(`2026-01-15T13:${String(minute).padStart(2, "0")}:00Z`);
      const verdict = checkQuietHours(config, at);
      if (verdict.quiet) expect(verdict.retryAfterMs).toBeGreaterThan(0);
    }
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones and refuses everything else", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone(NEW_YORK)).toBe(true);
    expect(isValidTimezone("EST5EDT")).toBe(true);

    expect(isValidTimezone("America/Nowhere")).toBe(false);
    expect(isValidTimezone("GMT+5")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
