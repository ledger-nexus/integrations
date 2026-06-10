// Scheduler math tests. Pure functions — no DB.
//
// Covers:
//   - validateIntervalMinutes: bound enforcement, integer-only
//   - computeNextSyncAt: arithmetic, minute-truncation
//   - isDueNow: gate composition (enabled / interval / nextSyncAt /
//     status / lastSyncStatus)
//   - describeNextRun: status text generation

import { describe, it, expect } from "vitest";
import {
  validateIntervalMinutes,
  computeNextSyncAt,
  isDueNow,
  describeNextRun,
  IntervalValidationError,
  SCHEDULER_MIN_INTERVAL_MINUTES,
  SCHEDULER_MAX_INTERVAL_MINUTES,
  type SchedulerConnectionView,
} from "../src/lib/sync/scheduler";

// ─────────────────────────────────────────────────────────────────────────────
// validateIntervalMinutes
// ─────────────────────────────────────────────────────────────────────────────

describe("validateIntervalMinutes", () => {
  it("accepts the minimum (5)", () => {
    expect(validateIntervalMinutes(SCHEDULER_MIN_INTERVAL_MINUTES)).toBe(5);
  });

  it("accepts the maximum (1440 = 24h)", () => {
    expect(validateIntervalMinutes(SCHEDULER_MAX_INTERVAL_MINUTES)).toBe(1440);
  });

  it("accepts common preset values", () => {
    expect(validateIntervalMinutes(15)).toBe(15);
    expect(validateIntervalMinutes(60)).toBe(60);
    expect(validateIntervalMinutes(240)).toBe(240);
  });

  it("rejects below the minimum", () => {
    expect(() => validateIntervalMinutes(4)).toThrow(IntervalValidationError);
    expect(() => validateIntervalMinutes(1)).toThrow(/Plaid rate-limits/);
  });

  it("rejects above the maximum", () => {
    expect(() => validateIntervalMinutes(1441)).toThrow(/24h/);
  });

  it("rejects non-integer values", () => {
    expect(() => validateIntervalMinutes(30.5)).toThrow(/whole number/);
  });

  it("rejects NaN / Infinity defensively", () => {
    expect(() => validateIntervalMinutes(NaN)).toThrow(IntervalValidationError);
    expect(() => validateIntervalMinutes(Infinity)).toThrow(IntervalValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeNextSyncAt
// ─────────────────────────────────────────────────────────────────────────────

describe("computeNextSyncAt", () => {
  it("adds the interval to the baseline", () => {
    const base = new Date("2026-05-28T10:00:00Z");
    const next = computeNextSyncAt({ baselineAt: base, intervalMinutes: 60 });
    expect(next.toISOString()).toBe("2026-05-28T11:00:00.000Z");
  });

  it("truncates seconds + ms so cron tick alignment is clean", () => {
    const base = new Date("2026-05-28T10:00:23.456Z");
    const next = computeNextSyncAt({ baselineAt: base, intervalMinutes: 15 });
    expect(next.toISOString()).toBe("2026-05-28T10:15:00.000Z");
  });

  it("handles intervals that cross day boundaries", () => {
    const base = new Date("2026-05-28T23:30:00Z");
    const next = computeNextSyncAt({ baselineAt: base, intervalMinutes: 60 });
    expect(next.toISOString()).toBe("2026-05-29T00:30:00.000Z");
  });

  it("throws if the interval is out of bounds", () => {
    expect(() =>
      computeNextSyncAt({ baselineAt: new Date(), intervalMinutes: 2 })
    ).toThrow(IntervalValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDueNow
// ─────────────────────────────────────────────────────────────────────────────

// Note: explicit hasOwnProperty checks rather than ?? — explicit null
// overrides must survive (we test null cases for interval / nextSyncAt).
function conn(over: Partial<SchedulerConnectionView> = {}): SchedulerConnectionView {
  return {
    scheduleEnabled: "scheduleEnabled" in over ? over.scheduleEnabled! : true,
    syncIntervalMinutes: "syncIntervalMinutes" in over ? over.syncIntervalMinutes! : 60,
    nextSyncAt:
      "nextSyncAt" in over ? over.nextSyncAt! : new Date("2026-05-28T10:00:00Z"),
    status: "status" in over ? over.status! : "ACTIVE",
    lastSyncStatus: "lastSyncStatus" in over ? over.lastSyncStatus! : "SUCCESS",
  };
}

describe("isDueNow", () => {
  const now = new Date("2026-05-28T10:00:00Z");

  it("returns true when nextSyncAt is exactly now", () => {
    expect(isDueNow(conn(), now)).toBe(true);
  });

  it("returns true when nextSyncAt is in the past", () => {
    expect(
      isDueNow(conn({ nextSyncAt: new Date("2026-05-28T09:00:00Z") }), now)
    ).toBe(true);
  });

  it("returns false when nextSyncAt is in the future", () => {
    expect(
      isDueNow(conn({ nextSyncAt: new Date("2026-05-28T11:00:00Z") }), now)
    ).toBe(false);
  });

  it("returns false when schedule is disabled", () => {
    expect(isDueNow(conn({ scheduleEnabled: false }), now)).toBe(false);
  });

  it("returns false when interval is null (incomplete schedule)", () => {
    expect(isDueNow(conn({ syncIntervalMinutes: null }), now)).toBe(false);
  });

  it("returns false when nextSyncAt is null", () => {
    expect(isDueNow(conn({ nextSyncAt: null }), now)).toBe(false);
  });

  it("returns false for non-ACTIVE statuses", () => {
    expect(isDueNow(conn({ status: "PAUSED" }), now)).toBe(false);
    expect(isDueNow(conn({ status: "REVOKED" }), now)).toBe(false);
    expect(isDueNow(conn({ status: "ERROR" }), now)).toBe(false);
  });

  it("returns false when a sync is already RUNNING (don't pile up)", () => {
    expect(isDueNow(conn({ lastSyncStatus: "RUNNING" }), now)).toBe(false);
  });

  it("returns true when last sync FAILED — schedule keeps trying", () => {
    expect(isDueNow(conn({ lastSyncStatus: "FAILURE" }), now)).toBe(true);
  });

  it("returns true when last sync was PARTIAL_SUCCESS", () => {
    expect(isDueNow(conn({ lastSyncStatus: "PARTIAL_SUCCESS" }), now)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeNextRun
// ─────────────────────────────────────────────────────────────────────────────

describe("describeNextRun", () => {
  const now = new Date("2026-05-28T10:00:00Z");

  it("says 'off' when schedule is disabled", () => {
    expect(describeNextRun(conn({ scheduleEnabled: false }), now)).toBe("off");
  });

  it("says 'schedule incomplete' when interval is null", () => {
    expect(describeNextRun(conn({ syncIntervalMinutes: null }), now)).toContain(
      "incomplete"
    );
  });

  it("says 'due now' when nextSyncAt = now", () => {
    expect(describeNextRun(conn(), now)).toBe("due now");
  });

  it("formats minutes-only when < 1h away", () => {
    expect(
      describeNextRun(
        conn({ nextSyncAt: new Date("2026-05-28T10:15:00Z") }),
        now
      )
    ).toBe("in 15m");
  });

  it("formats hours when < 24h away", () => {
    expect(
      describeNextRun(
        conn({ nextSyncAt: new Date("2026-05-28T13:45:00Z") }),
        now
      )
    ).toBe("in 3h 45m");
  });

  it("formats hours cleanly when no remainder minutes", () => {
    expect(
      describeNextRun(
        conn({ nextSyncAt: new Date("2026-05-28T14:00:00Z") }),
        now
      )
    ).toBe("in 4h");
  });

  it("formats days when > 24h", () => {
    expect(
      describeNextRun(
        conn({ nextSyncAt: new Date("2026-05-30T10:00:00Z") }),
        now
      )
    ).toBe("in 2d");
  });

  it("calls out overdue connections", () => {
    expect(
      describeNextRun(
        conn({ nextSyncAt: new Date("2026-05-28T09:30:00Z") }),
        now
      )
    ).toBe("overdue by 30m");
  });

  it("reflects non-ACTIVE status as paused", () => {
    expect(describeNextRun(conn({ status: "ERROR" }), now)).toContain("ERROR");
  });
});
