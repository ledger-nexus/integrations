"use server";

// Server Action to manually trigger a sync on an existing Connection.
// Backs the "Sync now" button on each connection row in the dashboard.

import { revalidatePath } from "next/cache";
import { runConnectionSync } from "@/lib/sync/runner";

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
  if (!connectionId) {
    return { ok: false, message: "connectionId required" };
  }

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
}
