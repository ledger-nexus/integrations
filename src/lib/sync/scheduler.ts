// Sync scheduler math. Pure functions, no DB, no I/O.
//
// The cron tick (every 5 min via Vercel Cron, see vercel.json) calls
// `pickDueConnections` to figure out who's overdue, then runs syncs
// sequentially. The schedule "next time" math lives here so it's
// unit-testable in isolation from the DB lease semantics.
//
// Why this design over pg_boss:
//
//   We deploy this Next.js app on Vercel, which doesn't host
//   long-running worker processes. pg_boss assumes an always-on
//   `boss.work()` consumer. The closest fit on serverless is a
//   recurring tick (Vercel Cron) that pulls due work from a queue —
//   functionally the pg_boss pattern, but driven by cron instead of
//   a polling daemon. We adopt the lease pattern (SELECT FOR UPDATE
//   SKIP LOCKED in `lease.ts`) directly; we skip the library itself.
//
// Interval bounds:
//
//   - MIN 5 minutes. Plaid rate-limits aggressive polling, and the
//     full sync round-trip (fetch → stage → recon bridge) for a
//     typical bank account is ~2-5s — running it every minute is
//     wasteful.
//   - MAX 24 hours (1440 min). Beyond a day the operator should
//     reconsider whether the connection is actually live.
//   - Step granularity: 1 min. We don't enforce coarser steps
//     (15/30/60); the UI suggests common values.

export const SCHEDULER_MIN_INTERVAL_MINUTES = 5;
export const SCHEDULER_MAX_INTERVAL_MINUTES = 24 * 60;

export class IntervalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntervalValidationError";
  }
}

/**
 * Validate a candidate interval. Throws with a specific message; the
 * server action surfaces it verbatim to the operator.
 */
export function validateIntervalMinutes(minutes: number): number {
  if (!Number.isInteger(minutes)) {
    throw new IntervalValidationError(
      `Interval must be a whole number of minutes (got ${minutes})`
    );
  }
  if (minutes < SCHEDULER_MIN_INTERVAL_MINUTES) {
    throw new IntervalValidationError(
      `Interval must be at least ${SCHEDULER_MIN_INTERVAL_MINUTES} minutes (got ${minutes}). Plaid rate-limits faster polling.`
    );
  }
  if (minutes > SCHEDULER_MAX_INTERVAL_MINUTES) {
    throw new IntervalValidationError(
      `Interval cannot exceed ${SCHEDULER_MAX_INTERVAL_MINUTES} minutes / 24h (got ${minutes}). If the connection is dormant longer than that, pause the schedule instead.`
    );
  }
  return minutes;
}

/**
 * Compute the next scheduled-run timestamp after a sync completed (or
 * a schedule was freshly set). Always pegged to a clean wall-clock
 * minute — we round to the nearest minute so the cron tick (which
 * also runs on minute boundaries) doesn't have a +/-30s offset
 * forever.
 */
export function computeNextSyncAt(input: {
  /** Whatever the operator just did happened at this moment. */
  baselineAt: Date;
  intervalMinutes: number;
}): Date {
  const baseMs = input.baselineAt.getTime();
  const interval = validateIntervalMinutes(input.intervalMinutes);
  const next = new Date(baseMs + interval * 60_000);
  // Truncate seconds + ms so cron-tick lockstep is clean.
  next.setSeconds(0, 0);
  return next;
}

/**
 * Decide whether a connection is currently due. Centralizing this
 * makes the cron tick's "should I claim this row?" check trivial and
 * matches the behaviour the SQL lease query enforces in production.
 *
 * A connection is due when:
 *   - scheduleEnabled = true
 *   - syncIntervalMinutes is set (defensive — schema allows enabled
 *     without an interval but we treat that as "not due")
 *   - nextSyncAt <= now
 *   - status is ACTIVE (PAUSED/REVOKED/ERROR drop out — operator
 *     intervention required)
 *   - lastSyncStatus is not RUNNING (don't pile up on a stuck sync)
 */
export interface SchedulerConnectionView {
  scheduleEnabled: boolean;
  syncIntervalMinutes: number | null;
  nextSyncAt: Date | null;
  status: "ACTIVE" | "PAUSED" | "REVOKED" | "ERROR";
  lastSyncStatus: "RUNNING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | null;
}

export function isDueNow(
  conn: SchedulerConnectionView,
  now: Date = new Date()
): boolean {
  if (!conn.scheduleEnabled) return false;
  if (conn.syncIntervalMinutes == null) return false;
  if (conn.nextSyncAt == null) return false;
  if (conn.status !== "ACTIVE") return false;
  if (conn.lastSyncStatus === "RUNNING") return false;
  return conn.nextSyncAt.getTime() <= now.getTime();
}

/**
 * Human-readable description of when this connection is next due.
 * Used on the UI ("in 3h 12m", "12 minutes ago — overdue", etc.).
 */
export function describeNextRun(
  conn: SchedulerConnectionView,
  now: Date = new Date()
): string {
  if (!conn.scheduleEnabled) return "off";
  if (conn.syncIntervalMinutes == null || conn.nextSyncAt == null) {
    return "schedule incomplete";
  }
  if (conn.status !== "ACTIVE") return `${conn.status} — schedule paused`;
  const diffMs = conn.nextSyncAt.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin === 0) return "due now";
  if (diffMin < 0) return `overdue by ${humanizeMinutes(-diffMin)}`;
  return `in ${humanizeMinutes(diffMin)}`;
}

function humanizeMinutes(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  if (hours < 24) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/**
 * Common preset intervals surfaced in the schedule UI. Operators can
 * type any value within bounds, but these are the defaults the
 * dropdown offers.
 */
export const SCHEDULER_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "Every 15 minutes", minutes: 15 },
  { label: "Every 30 minutes", minutes: 30 },
  { label: "Hourly", minutes: 60 },
  { label: "Every 4 hours", minutes: 240 },
  { label: "Every 12 hours", minutes: 720 },
  { label: "Daily", minutes: 1440 },
];
