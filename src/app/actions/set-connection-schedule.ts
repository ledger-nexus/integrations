"use server";

// Server Action: configure (or disable) the auto-sync schedule for a
// single Connection.
//
// Workflow:
//
//   Disable schedule:
//     setConnectionScheduleAction({ connectionId, enabled: false })
//     - Sets scheduleEnabled = false. Preserves syncIntervalMinutes
//       and nextSyncAt so the operator can re-enable without
//       re-entering the interval.
//
//   Enable / reconfigure schedule:
//     setConnectionScheduleAction({ connectionId, enabled: true,
//                                   intervalMinutes: 60 })
//     - Validates interval is within bounds (5 min – 24h).
//     - Sets scheduleEnabled = true, syncIntervalMinutes = N,
//       nextSyncAt = now + N (truncated to minute boundary so the
//       cron tick aligns).
//
// Tenant-scoping: Connection.targetId → BankAccount → entity.tenantId.
// Same chain trigger-sync and connection detail use.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  validateIntervalMinutes,
  computeNextSyncAt,
  IntervalValidationError,
} from "@/lib/sync/scheduler";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";

export interface SetConnectionScheduleInput {
  connectionId: string;
  enabled: boolean;
  /** Required when enabled = true. */
  intervalMinutes?: number;
}

export interface SetConnectionScheduleState {
  ok: boolean;
  message: string;
  nextSyncAt?: string;
}

export async function setConnectionScheduleAction(
  input: SetConnectionScheduleInput
): Promise<SetConnectionScheduleState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();

    const connection = await prisma.connection.findUnique({
      where: { id: input.connectionId },
      select: {
        id: true,
        targetType: true,
        targetId: true,
        status: true,
      },
    });
    if (!connection) {
      return { ok: false, message: "Connection not found" };
    }

    // Tenant-scope via the target. Same canonical chain triggerSync uses.
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
        message: "Cannot schedule a connection without a tenant-resolvable target",
      };
    }

    if (input.enabled) {
      if (input.intervalMinutes == null) {
        return {
          ok: false,
          message: "intervalMinutes is required when enabling the schedule",
        };
      }
      let interval: number;
      try {
        interval = validateIntervalMinutes(input.intervalMinutes);
      } catch (e) {
        if (e instanceof IntervalValidationError) {
          return { ok: false, message: e.message };
        }
        throw e;
      }
      const nextSyncAt = computeNextSyncAt({
        baselineAt: new Date(),
        intervalMinutes: interval,
      });
      await prisma.connection.update({
        where: { id: connection.id },
        data: {
          scheduleEnabled: true,
          syncIntervalMinutes: interval,
          nextSyncAt,
        },
      });
      revalidatePath(`/connections/${connection.id}`);
      revalidatePath("/connections");
      return {
        ok: true,
        message: `Schedule set: every ${interval} min. Next run ${nextSyncAt.toISOString()}.`,
        nextSyncAt: nextSyncAt.toISOString(),
      };
    } else {
      // Disabling: flip the switch, preserve interval + nextSyncAt so
      // re-enabling later returns to the same cadence without
      // re-entering values.
      await prisma.connection.update({
        where: { id: connection.id },
        data: { scheduleEnabled: false },
      });
      revalidatePath(`/connections/${connection.id}`);
      revalidatePath("/connections");
      return { ok: true, message: "Schedule paused" };
    }
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
