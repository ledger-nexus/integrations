// Lease helper for the scheduled-sync cron.
//
// Two Vercel Cron invocations CAN overlap (the prior tick takes
// longer than the interval), and we want exactly-once-per-tick
// semantics: each due connection is claimed by at most one cron
// instance, even if two run concurrently.
//
// Postgres gives us this for free via SELECT ... FOR UPDATE SKIP
// LOCKED — the pg_boss pattern. We:
//
//   1. Open a transaction.
//   2. SELECT the IDs of due connections, LOCKING them, but SKIPPING
//      any row another transaction already holds.
//   3. Stamp `lastScheduledRunAt = now()` on each claimed row so the
//      cron tick's "I tried to look at you" trace is preserved even
//      when the sync subsequently fails.
//   4. Commit. The IDs returned are the ones THIS cron instance owns
//      for this tick.
//
// The actual sync work happens OUTSIDE the lease transaction — we
// only need the lease to coordinate which instance picks up which
// connection, not to hold a lock for the duration of the sync (which
// could easily be 30s+). The existing per-connection `lastSyncStatus
// = RUNNING` guard in runner.ts prevents double-sync if a second
// concurrent run somehow targets the same connection anyway.
//
// `tx` parameter is the Prisma transaction client — the caller wraps
// the whole lease in a `prisma.$transaction(async (tx) => …)`.

import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

export interface LeaseClaim {
  connectionId: string;
  systemCode: string;
  nextSyncAt: Date;
}

/**
 * Claim up to `limit` connections that are due now. Stamps
 * `lastScheduledRunAt` on each claimed row inside the same
 * transaction so an operator looking at the row knows the cron
 * touched it even when the subsequent sync was skipped.
 *
 * Returns the claimed rows in `nextSyncAt` ascending order — the
 * most-overdue connections get processed first.
 *
 * Atomicity guarantees:
 *   - Two concurrent calls never claim the same row (SKIP LOCKED).
 *   - The `lastScheduledRunAt` stamp is committed atomically with
 *     the claim — a crashed cron between claim and stamp is
 *     impossible.
 *
 * After this returns, the caller runs each sync independently
 * (failure-isolated). A sync failure does NOT undo the lease — the
 * next tick will see the row's `nextSyncAt` is still in the past
 * and try again, subject to its own RUNNING guard.
 */
export async function claimDueConnections(input: {
  /** Maximum rows to claim this tick. Cron should bound this so a backlog doesn't blow the function timeout. */
  limit: number;
  /** Test seam — defaults to NOW(). */
  nowMs?: number;
}): Promise<LeaseClaim[]> {
  const limit = Math.max(1, Math.min(100, input.limit));
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);

  return prisma.$transaction(async (tx) => {
    // The Prisma typed query API doesn't expose FOR UPDATE SKIP
    // LOCKED, so we drop to $queryRaw for the lease select. The
    // parameters are bound (Prisma.sql template literal) — no
    // injection risk.
    const claimed = await tx.$queryRaw<
      Array<{
        id: string;
        system_code: string;
        next_sync_at: Date;
      }>
    >(Prisma.sql`
      SELECT id, system_code, next_sync_at
      FROM connection
      WHERE schedule_enabled = TRUE
        AND sync_interval_minutes IS NOT NULL
        AND next_sync_at IS NOT NULL
        AND next_sync_at <= ${now}
        AND status = 'ACTIVE'
        AND (last_sync_status IS NULL OR last_sync_status != 'RUNNING')
        AND deactivated_at IS NULL
      ORDER BY next_sync_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    if (claimed.length === 0) return [];

    // Stamp lastScheduledRunAt in the same transaction. We don't
    // touch nextSyncAt here — it advances after the sync completes
    // (success or failure), via advanceNextSyncAt below.
    const ids = claimed.map((r) => r.id);
    await tx.connection.updateMany({
      where: { id: { in: ids } },
      data: { lastScheduledRunAt: now },
    });

    return claimed.map((r) => ({
      connectionId: r.id,
      systemCode: r.system_code,
      nextSyncAt: r.next_sync_at,
    }));
  });
}

/**
 * Advance the connection's `nextSyncAt` after a sync attempt.
 * Called by the cron handler whether the sync succeeded, failed, or
 * was skipped — the schedule should keep moving regardless. (Stuck
 * sync states surface via `lastSyncStatus = FAILURE` on the row.)
 *
 * The next time is computed from NOW + effective interval, NOT from
 * the prior `nextSyncAt + interval`. This means a backlog of missed
 * ticks doesn't trigger a flood of catch-up syncs — we sync at most
 * once per interval going forward.
 *
 * The effective interval is the base interval scaled by the backoff
 * math (see ./backoff.ts) — exponential growth from consecutive
 * failures, capped at 24h. Calling code passes the
 * `effectiveIntervalMinutes` it computed; we don't recompute here so
 * the cron's failure-counter update and this advance happen in a
 * consistent snapshot.
 */
export async function advanceNextSyncAt(input: {
  connectionId: string;
  /** Base interval × backoff multiplier. Caller computes; we apply. */
  effectiveIntervalMinutes: number;
  /** Updated failure count to persist alongside the schedule advance. */
  consecutiveFailureCount: number;
  nowMs?: number;
}): Promise<void> {
  const now = new Date(input.nowMs ?? Date.now());
  const next = new Date(now.getTime() + input.effectiveIntervalMinutes * 60_000);
  // Truncate to minute boundary — matches the scheduler module.
  next.setSeconds(0, 0);
  await prisma.connection.update({
    where: { id: input.connectionId },
    data: {
      nextSyncAt: next,
      consecutiveFailureCount: input.consecutiveFailureCount,
    },
  });
}
