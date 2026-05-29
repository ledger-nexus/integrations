"use server";

// Server Action: manually reset a connection's consecutive-failure
// counter back to zero.
//
// When is this useful? An operator who's just resolved a long-running
// failure (e.g., re-linked an account whose Plaid auth expired)
// doesn't want to wait for the next backed-off attempt — which might
// be 24h out — to confirm the fix worked. Resetting the counter pulls
// the schedule back to the base interval and the next cron tick picks
// the connection up immediately if it's already past `nextSyncAt`.
//
// The cron tick still resets the counter on its own when a sync
// succeeds; this action exists purely for the impatient-recovery
// case.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { computeNextSyncAt } from "@/lib/sync/scheduler";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export interface ResetFailureCountState {
  ok: boolean;
  message: string;
  nextSyncAt?: string;
}

export async function resetFailureCountAction(
  connectionId: string
): Promise<ResetFailureCountState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        targetType: true,
        targetId: true,
        syncIntervalMinutes: true,
        scheduleEnabled: true,
        consecutiveFailureCount: true,
      },
    });
    if (!connection) {
      return { ok: false, message: "Connection not found" };
    }

    // Tenant-scope check via target → BankAccount → entity. Same chain
    // setConnectionScheduleAction uses.
    if (connection.targetType === "BANK_ACCOUNT" && connection.targetId) {
      const bankAccount = await prisma.bankAccount.findFirst({
        where: { id: connection.targetId, entity: { tenantId: tenant.id } },
        select: { id: true },
      });
      if (!bankAccount) {
        return { ok: false, message: "Connection not found in this tenant" };
      }
    } else {
      return {
        ok: false,
        message: "Cannot operate on a connection without a tenant-resolvable target",
      };
    }

    if (connection.consecutiveFailureCount === 0) {
      return {
        ok: true,
        message: "Failure counter is already 0 — nothing to reset",
      };
    }

    // Pull the schedule back to the base interval. If a schedule is
    // configured, set nextSyncAt = now + base interval; otherwise just
    // reset the counter (the operator can still trigger a manual sync
    // from the UI button).
    const updateData: Record<string, unknown> = { consecutiveFailureCount: 0 };
    if (connection.scheduleEnabled && connection.syncIntervalMinutes != null) {
      updateData.nextSyncAt = computeNextSyncAt({
        baselineAt: new Date(),
        intervalMinutes: connection.syncIntervalMinutes,
      });
    }
    await prisma.connection.update({
      where: { id: connection.id },
      data: updateData,
    });

    revalidatePath(`/connections/${connection.id}`);
    revalidatePath("/connections");
    return {
      ok: true,
      message: `Reset ${connection.consecutiveFailureCount} consecutive failure(s); back to base interval`,
      nextSyncAt:
        updateData.nextSyncAt instanceof Date ? updateData.nextSyncAt.toISOString() : undefined,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
