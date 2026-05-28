// GET /api/cron/run-scheduled-syncs
//
// Vercel Cron hits this every 5 minutes (see vercel.json). The
// handler:
//
//   1. Authenticates via CRON_SECRET (same pattern as the other
//      portfolio crons — ledger-core's report-ai-usage, fa-amort's
//      cleanup, etc.).
//   2. Claims up to N due connections via the lease helper
//      (SELECT FOR UPDATE SKIP LOCKED — two concurrent ticks
//      can never claim the same row).
//   3. Runs each claimed sync sequentially through the existing
//      runConnectionSync. Failure-isolated: one sync failure doesn't
//      abort the batch.
//   4. Advances each connection's `nextSyncAt` to now+interval
//      regardless of sync outcome — the schedule keeps moving;
//      stuck-sync states surface via `lastSyncStatus = FAILURE`
//      on the row.
//
// Why sequential rather than parallel:
//   - Plaid rate-limits per access token, and a parallel burst can
//     trip those limits.
//   - The function timeout on Vercel Hobby is 10s, Pro is 60s. A
//     full Plaid sync round-trip averages ~3s; sequential 3-5 per
//     tick fits comfortably.
//   - If the backlog ever exceeds what fits in one tick, the next
//     tick picks up the remainder — the lease pattern guarantees no
//     double-work.
//
// LIMIT default 10:
//   - For 5-min ticks at 60-min default intervals, steady-state is
//     well under 1 claim per tick per 12 active connections. 10 is
//     ~20× headroom for backlog.
//   - Override via `?limit=N` query param for ops catch-up.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { claimDueConnections, advanceNextSyncAt } from "@/lib/sync/lease";
import { runConnectionSync } from "@/lib/sync/runner";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 10;

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

interface RunDetail {
  connectionId: string;
  systemCode: string;
  outcome:
    | "SYNC_OK"
    | "SYNC_FAILED"
    | "SKIPPED_LOCKED"
    | "SKIPPED_NO_INTERVAL"
    | "ERROR";
  syncRunId?: string;
  recordsAdded?: number;
  recordsPromoted?: number;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";

  if (!secret) {
    if (isProd()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "CRON_SECRET env var is not set — endpoint disabled in production. Set it in the deployment env to enable Vercel Cron invocations.",
        },
        { status: 503 }
      );
    }
    // Dev pass-through: no secret required when not in production.
  } else {
    const expected = `Bearer ${secret}`;
    if (!constantTimeEquals(authHeader, expected)) {
      return NextResponse.json(
        { ok: false, error: "Invalid or missing bearer token" },
        { status: 401 }
      );
    }
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || DEFAULT_LIMIT)) : DEFAULT_LIMIT;

  const startMs = Date.now();
  const claims = await claimDueConnections({ limit });
  const details: RunDetail[] = [];

  let syncOk = 0;
  let syncFailed = 0;
  let skipped = 0;

  for (const claim of claims) {
    // The runner needs to know the interval to advance nextSyncAt
    // after. We re-read because the lease only returned a few fields
    // for footprint; the row was already in the working set, so this
    // is a cheap cache hit.
    const conn = await prisma.connection.findUnique({
      where: { id: claim.connectionId },
      select: { syncIntervalMinutes: true },
    });
    if (!conn || conn.syncIntervalMinutes == null) {
      skipped += 1;
      details.push({
        connectionId: claim.connectionId,
        systemCode: claim.systemCode,
        outcome: "SKIPPED_NO_INTERVAL",
      });
      continue;
    }

    try {
      const result = await runConnectionSync({
        connectionId: claim.connectionId,
        triggerType: "SCHEDULED",
      });
      if (result.status === "SKIPPED_LOCKED") {
        skipped += 1;
        details.push({
          connectionId: claim.connectionId,
          systemCode: claim.systemCode,
          outcome: "SKIPPED_LOCKED",
          syncRunId: result.syncRunId,
        });
      } else if (result.status === "FAILURE") {
        syncFailed += 1;
        details.push({
          connectionId: claim.connectionId,
          systemCode: claim.systemCode,
          outcome: "SYNC_FAILED",
          syncRunId: result.syncRunId,
          error: result.error,
        });
      } else {
        syncOk += 1;
        details.push({
          connectionId: claim.connectionId,
          systemCode: claim.systemCode,
          outcome: "SYNC_OK",
          syncRunId: result.syncRunId,
          recordsAdded: result.recordsAdded,
          recordsPromoted: result.recordsPromoted,
        });
      }
    } catch (e) {
      // The runner shouldn't throw — it catches and returns FAILURE —
      // but if something escapes (network, prisma client wedge) we
      // still want to advance the schedule so we don't pile up on
      // the same bad connection every tick.
      syncFailed += 1;
      details.push({
        connectionId: claim.connectionId,
        systemCode: claim.systemCode,
        outcome: "ERROR",
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }

    // Advance the schedule no matter what — even on FAILURE/ERROR.
    // The connection's lastSyncStatus carries the bad-state signal;
    // we don't want to stop trying.
    try {
      await advanceNextSyncAt({
        connectionId: claim.connectionId,
        intervalMinutes: conn.syncIntervalMinutes,
      });
    } catch (e) {
      console.error(
        "[cron] failed to advance nextSyncAt for",
        claim.connectionId,
        e
      );
    }
  }

  const durationMs = Date.now() - startMs;
  const summary = {
    ok: true,
    claimed: claims.length,
    syncOk,
    syncFailed,
    skipped,
    durationMs,
  };

  // Vercel function logs surface this — useful for "did anything
  // happen this tick?" without leaving the Vercel UI.
  console.log("[cron] run-scheduled-syncs", JSON.stringify(summary));

  return NextResponse.json({
    ...summary,
    ...(url.searchParams.get("verbose") === "1" ? { details } : {}),
  });
}
