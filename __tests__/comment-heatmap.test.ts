import { describe, expect, it } from "vitest";

import { buildHeatmap, describePeak } from "../lib/analytics/comment-heatmap";

describe("buildHeatmap", () => {
  it("places counts at the right day and hour", () => {
    const heatmap = buildHeatmap(
      [
        { dow: 0, hour: 0, count: 3 },
        { dow: 2, hour: 19, count: 41 },
        { dow: 6, hour: 23, count: 7 },
      ],
      "America/New_York",
      90
    );

    expect(heatmap.matrix[0][0]).toBe(3);
    expect(heatmap.matrix[2][19]).toBe(41);
    expect(heatmap.matrix[6][23]).toBe(7);
    expect(heatmap.total).toBe(51);
  });

  it("returns a full 7 by 24 grid even with no data", () => {
    const heatmap = buildHeatmap([], "UTC", 90);

    expect(heatmap.matrix).toHaveLength(7);
    for (const row of heatmap.matrix) {
      expect(row).toHaveLength(24);
      expect(row.every((cell) => cell === 0)).toBe(true);
    }
    expect(heatmap.total).toBe(0);
    expect(heatmap.peak).toBeNull();
  });

  it("finds the busiest cell", () => {
    const heatmap = buildHeatmap(
      [
        { dow: 1, hour: 9, count: 10 },
        { dow: 4, hour: 20, count: 55 },
        { dow: 5, hour: 12, count: 54 },
      ],
      "UTC",
      90
    );

    expect(heatmap.peak).toEqual({ day: 4, hour: 20, count: 55 });
  });

  // A malformed row must not write outside the grid, and must not silently
  // land in the wrong day, which is what an unguarded index would do.
  it("drops rows outside the grid rather than corrupting it", () => {
    const heatmap = buildHeatmap(
      [
        { dow: 7, hour: 0, count: 99 },
        { dow: -1, hour: 0, count: 99 },
        { dow: 0, hour: 24, count: 99 },
        { dow: 0, hour: -1, count: 99 },
        { dow: 3, hour: 3, count: 5 },
      ],
      "UTC",
      90
    );

    expect(heatmap.total).toBe(5);
    expect(heatmap.matrix).toHaveLength(7);
    expect(heatmap.matrix[3][3]).toBe(5);
  });

  it("carries the timezone and window through, since the chart labels them", () => {
    const heatmap = buildHeatmap([], "Europe/London", 30);

    expect(heatmap.timezone).toBe("Europe/London");
    expect(heatmap.windowDays).toBe(30);
  });
});

describe("describePeak", () => {
  it("reads as a sentence, not a coordinate", () => {
    expect(describePeak({ day: 2, hour: 19, count: 41 })).toBe(
      "Tuesday around 7pm"
    );
    expect(describePeak({ day: 0, hour: 9, count: 12 })).toBe(
      "Sunday around 9am"
    );
  });

  // The two that a naive hour % 12 gets wrong, rendering both as "0".
  it("says 12am and 12pm rather than 0am and 0pm", () => {
    expect(describePeak({ day: 1, hour: 0, count: 5 })).toBe(
      "Monday around 12am"
    );
    expect(describePeak({ day: 1, hour: 12, count: 5 })).toBe(
      "Monday around 12pm"
    );
  });

  it("says nothing when there is nothing to say", () => {
    expect(describePeak(null)).toBeNull();
    expect(describePeak({ day: 0, hour: 0, count: 0 })).toBeNull();
  });
});
