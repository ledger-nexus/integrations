"use server";

// Server Action to manually trigger a sync on an existing Connection.
// Backs the "Sync now" button on each connection row in the dashboard.
//
// SECURITY (pen-test pass 4): requires a signed-in user with an active
// tenant, and tenant-scopes the Connection lookup via
// connection → target BankAccount → entity → tenantId. Without this
// gate, an attacker could call the action with any tenant's
// connectionId and trigger an unauthorized sync (which writes
// BankStatement + BankStatementLine rows into the victim's recon
// books — same exfiltration/pollution risk as complete-plaid-link).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { runConnectionSync } from "@/lib/sync/runner";
import {
  requireCurrentUser,
  requireCurrentTenant,
  NotAuthenticatedError,
  NoTenantSelectedError,
} from "@/lib/auth/session";
import { requireRepoAccess, RepoNotIncludedError } from "@/lib/auth/repo-access";

export interface TriggerSyncState {
  ok: boolean;
  syncRunId?: string;
  recordsAdded?: number;
  recordsPromoted?: number;
  bankStatementId?: string;
  message?: string;
}

export async function triggerSyncAction(
  connectionId: string
): Promise<TriggerSyncState> {
  try {
    await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requireRepoAccess(tenant);

    if (!connectionId) {
      return { ok: false, message: "connectionId required" };
    }

    // Tenant-scope the Connection lookup. Only BANK_ACCOUNT targets
    // are wired up today; the join walks Connection.targetId →
    // BankAccount.id → entity.tenantId.
    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
      select: { id: true, targetType: true, targetId: true },
    });
    if (!connection) {
      return { ok: false, message: "Connection not found" };
    }
    if (connection.targetType === "BANK_ACCOUNT" && connection.targetId) {
      const bankAccount = await prisma.bankAccount.findFirst({
        where: { id: connection.targetId, entity: { tenantId: tenant.id } },
        select: { id: true },
      });
      if (!bankAccount) {
        return { ok: false, message: "Connection not found in this tenant" };
      }
    }
    // (Future targetTypes — PARTY, GL_ACCOUNT, etc. — must add their
    // own tenant-resolution branch here.)

    const result = await runConnectionSync({
      connectionId,
      triggerType: "MANUAL",
    });

    revalidatePath("/connections");
    revalidatePath(`/connections/${connectionId}`);
    revalidatePath("/");

    if (result.status === "FAILURE") {
      return { ok: false, message: result.error };
    }
    if (result.status === "SKIPPED_LOCKED") {
      return { ok: false, message: result.error };
    }
    return {
      ok: true,
      syncRunId: result.syncRunId,
      recordsAdded: result.recordsAdded,
      recordsPromoted: result.recordsPromoted,
      bankStatementId: result.bankStatementId,
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError)
      return { ok: false, message: "You must be signed in." };
    if (e instanceof NoTenantSelectedError)
      return { ok: false, message: e.message };
    if (e instanceof RepoNotIncludedError)
      return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}
