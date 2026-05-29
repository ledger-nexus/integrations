// Sync backoff math tests. Pure functions — no DB.
//
// Covers:
//   - computeBackoffMinutes: doubling progression, cap behavior,
//     interval-bounds enforcement, integer-only failure count
//   - nextFailureCount: SUCCESS resets, FAILURE/ERROR increments,
//     SKIPPED preserves
//   - describeBackoffState: text generation across the failure
//     count ladder

import { describe, it, expect } from "vitest";
import {
  computeBackoffMinutes,
  nextFailureCount,
  describeBackoffState,
  BACKOFF_MAX_MINUTES,
} from "../src/lib/sync/backoff";
import { IntervalValidationError } from "../src/lib/sync/scheduler";

// ─────────────────────────────────────────────────────────────────────────────
// computeBackoffMinutes
// ─────────────────────────────────────────────────────────────────────────────

describe("computeBackoffMinutes — happy progression", () => {
  it("returns the base interval when there are no failures", () => {
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 60, consecutiveFailureCount: 0 })
    ).toBe(60);
  });

  it("doubles for each consecutive failure", () => {
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 15, consecutiveFailureCount: 1 })
    ).toBe(30); // 2× 15
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 15, consecutiveFailureCount: 2 })
    ).toBe(60); // 4× 15
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 15, consecutiveFailureCount: 3 })
    ).toBe(120); // 8× 15
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 15, consecutiveFailureCount: 4 })
    ).toBe(240); // 16× 15
  });
});

describe("computeBackoffMinutes — cap behavior", () => {
  it("caps at BACKOFF_MAX_MINUTES (24h)", () => {
    // 15-min base, 7 failures = 128× = 1920 → capped at 1440
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 15, consecutiveFailureCount: 7 })
    ).toBe(BACKOFF_MAX_MINUTES);
  });

  it("stays capped for large failure counts (no overflow)", () => {
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 5, consecutiveFailureCount: 50 })
    ).toBe(BACKOFF_MAX_MINUTES);
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 5, consecutiveFailureCount: 100 })
    ).toBe(BACKOFF_MAX_MINUTES);
  });

  it("doesn't exceed the cap even on the first failure when base is already near max", () => {
    // 1000-min base, 1 failure = 2000 → capped at 1440
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 1000, consecutiveFailureCount: 1 })
    ).toBe(BACKOFF_MAX_MINUTES);
  });
});

describe("computeBackoffMinutes — defensive input handling", () => {
  it("validates the base interval (out of bounds throws)", () => {
    expect(() =>
      computeBackoffMinutes({ baseIntervalMinutes: 2, consecutiveFailureCount: 0 })
    ).toThrow(IntervalValidationError);
    expect(() =>
      computeBackoffMinutes({
        baseIntervalMinutes: 2000,
        consecutiveFailureCount: 0,
      })
    ).toThrow(IntervalValidationError);
  });

  it("treats negative or fractional failure counts as 0 / floor", () => {
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 30, consecutiveFailureCount: -1 })
    ).toBe(30);
    expect(
      computeBackoffMinutes({ baseIntervalMinutes: 30, consecutiveFailureCount: 2.7 })
    ).toBe(120); // floor(2.7) = 2, 4× 30 = 120
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextFailureCount
// ─────────────────────────────────────────────────────────────────────────────

describe("nextFailureCount", () => {
  it("resets to 0 on SUCCESS", () => {
    expect(nextFailureCount({ currentCount: 5, outcome: "SUCCESS" })).toBe(0);
    expect(nextFailureCount({ currentCount: 0, outcome: "SUCCESS" })).toBe(0);
  });

  it("resets to 0 on PARTIAL_SUCCESS (cursor still advanced)", () => {
    expect(nextFailureCount({ currentCount: 3, outcome: "PARTIAL_SUCCESS" })).toBe(0);
  });

  it("increments on FAILURE", () => {
    expect(nextFailureCount({ currentCount: 0, outcome: "FAILURE" })).toBe(1);
    expect(nextFailureCount({ currentCount: 5, outcome: "FAILURE" })).toBe(6);
  });

  it("increments on ERROR (treated the same as FAILURE)", () => {
    expect(nextFailureCount({ currentCount: 2, outcome: "ERROR" })).toBe(3);
  });

  it("preserves the count on SKIPPED (didn't actually try)", () => {
    expect(nextFailureCount({ currentCount: 4, outcome: "SKIPPED" })).toBe(4);
    expect(nextFailureCount({ currentCount: 0, outcome: "SKIPPED" })).toBe(0);
  });

  it("treats negative current counts defensively (clamps to 0)", () => {
    expect(nextFailureCount({ currentCount: -1, outcome: "FAILURE" })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeBackoffState
// ─────────────────────────────────────────────────────────────────────────────

describe("describeBackoffState", () => {
  it("says 'on schedule' when there are no failures", () => {
    expect(
      describeBackoffState({ baseIntervalMinutes: 60, consecutiveFailureCount: 0 })
    ).toBe("on schedule");
  });

  it("describes the multiplier for typical failure counts", () => {
    const r = describeBackoffState({
      baseIntervalMinutes: 30,
      consecutiveFailureCount: 3,
    });
    expect(r).toContain("8× base interval");
    expect(r).toContain("3 consecutive failure");
  });

  it("singular vs plural failure wording", () => {
    expect(
      describeBackoffState({ baseIntervalMinutes: 30, consecutiveFailureCount: 1 })
    ).toContain("1 consecutive failure");
    expect(
      describeBackoffState({ baseIntervalMinutes: 30, consecutiveFailureCount: 1 })
    ).not.toContain("failures"); // singular only
    expect(
      describeBackoffState({ baseIntervalMinutes: 30, consecutiveFailureCount: 2 })
    ).toContain("2 consecutive failures");
  });

  it("calls out the 24h cap explicitly", () => {
    const r = describeBackoffState({
      baseIntervalMinutes: 15,
      consecutiveFailureCount: 10,
    });
    expect(r).toContain("capped at 24h");
  });
});
