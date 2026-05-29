// Sync runner — the orchestrator that takes a Connection, calls the
// connector's fetchSince, normalizes via the mapper, stages, and
// promotes to recon.
//
// v0.1 is synchronous: one runConnectionSync call processes the full
// cursor-advance loop and returns when done. v0.2 will move this to a
// background job queue (pg_boss) and split it into per-page handlers
// so a long sync doesn't tie up a Server Action's request thread.
//
// Per-connection lock: atomic conditional UPDATE on lastSyncStatus.
// The runner claims the connection by SETing lastSyncStatus='RUNNING'
// WHERE id=? AND status='ACTIVE' AND (lastSyncStatus IS NULL OR
// lastSyncStatus != 'RUNNING'). Postgres serializes the update on
// the row — whichever transaction commits second sees zero rows
// affected and returns SKIPPED_LOCKED. This guards against the
// manual-trigger + cron-claim race the simple "read then check then
// write" pattern was vulnerable to.

import { prisma } from "@/lib/db";
import { plaidConnector } from "@/lib/connectors/plaid/connector";
import { plaidMapperV1 } from "@/lib/connectors/plaid/mapper";
import { promoteToBankStatement } from "@/lib/recon-bridge";
import type { Connector } from "@/lib/connectors/interface";
import type { PlaidTransaction } from "@/lib/connectors/plaid/types";

// Connector registry. Adding a new connector = adding a row here.
// systemCode → Connector module. The runner dispatches by systemCode
// on the Connection row.
const CONNECTOR_REGISTRY: Record<string, Connector<any>> = {
  plaid: plaidConnector,
};

export interface RunSyncInput {
  connectionId: string;
  triggerType: "MANUAL" | "SCHEDULED" | "WEBHOOK";
  /** Optional override of the actor user. Defaults to "system" for engine-fired. */
  actorUserId?: string;
}

export interface RunSyncResult {
  syncRunId: string;
  status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | "SKIPPED_LOCKED";
  recordsAdded: number;
  recordsPromoted: number;
  bankStatementId?: string;
  error?: string;
}

export async function runConnectionSync(input: RunSyncInput): Promise<RunSyncResult> {
  // 1. Atomic claim. Audit-pass deferred fix.
  //
  // Pre-fix: the runner did a findUnique → check lastSyncStatus !=
  // RUNNING → later update lastSyncStatus = RUNNING. That's a TOCTOU
  // race: two concurrent runners (e.g., manual trigger + cron lease)
  // could both pass the check between the read and the write, both
  // create SyncRun rows, and both proceed against the same connection.
  // The cron lease's SELECT FOR UPDATE SKIP LOCKED prevents two
  // cron-instances from claiming the same row, but doesn't protect
  // against a manual sync racing with a cron-claimed sync.
  //
  // Fix: atomic UPDATE … WHERE … with row-count check. Postgres
  // serializes concurrent updates on the row; whichever transaction
  // commits second sees zero rows affected (its WHERE no longer
  // matches the now-RUNNING row). The lastSyncStatus column needs an
  // IS NULL OR != 'RUNNING' check because fresh connections have it
  // as null. We drop to raw SQL because Prisma's typed { not: ... }
  // on a nullable enum doesn't include null reliably across versions.
  const claimedRows = await prisma.$executeRaw`
    UPDATE connection
    SET last_sync_status = 'RUNNING'
    WHERE id = ${input.connectionId}::uuid
      AND status = 'ACTIVE'
      AND (last_sync_status IS NULL OR last_sync_status != 'RUNNING')
  `;

  if (claimedRows === 0) {
    // Differentiate the cause for the caller. The findUnique is safe
    // even when locked because we're only reading non-volatile fields
    // to classify the failure.
    const conn = await prisma.connection.findUnique({
      where: { id: input.connectionId },
      select: { status: true, lastSyncStatus: true },
    });
    if (!conn) {
      return {
        syncRunId: "<missing>",
        status: "FAILURE",
        recordsAdded: 0,
        recordsPromoted: 0,
        error: "Connection not found",
      };
    }
    if (conn.status !== "ACTIVE") {
      return {
        syncRunId: "<skipped>",
        status: "FAILURE",
        recordsAdded: 0,
        recordsPromoted: 0,
        error: `Connection status=${conn.status} — sync skipped`,
      };
    }
    // Status is ACTIVE but the claim failed → must be RUNNING (or a
    // race we didn't catch above). Report as locked.
    return {
      syncRunId: "<locked>",
      status: "SKIPPED_LOCKED",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: "Another sync is already in progress for this connection",
    };
  }

  // 2. Claim succeeded. Read the full connection state — now safe
  // because we hold the RUNNING claim and no other runner can mutate
  // credentialsJson/lastCursor concurrently (their claim attempt
  // returns 0 rows). The atomic claim above also already flipped
  // lastSyncStatus to RUNNING, so the read sees that.
  const connection = await prisma.connection.findUnique({
    where: { id: input.connectionId },
    select: {
      id: true,
      systemCode: true,
      status: true,
      targetType: true,
      targetId: true,
      credentialsJson: true,
      lastCursor: true,
      lastSyncStatus: true,
      displayName: true,
    },
  });
  if (!connection) {
    // Vanishingly rare: row deleted between the claim and the read.
    // Don't try to release the claim (there's nothing to release).
    return {
      syncRunId: "<missing>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: "Connection vanished after claim",
    };
  }
  if (connection.targetType !== "BANK_ACCOUNT" || !connection.targetId) {
    // Release the claim — the connection isn't actually syncable.
    await prisma.connection.update({
      where: { id: connection.id },
      data: { lastSyncStatus: "FAILURE" },
    });
    return {
      syncRunId: "<no-target>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: "Connection has no BANK_ACCOUNT target — v0.1 only supports bank syncs",
    };
  }

  const connector = CONNECTOR_REGISTRY[connection.systemCode];
  if (!connector) {
    // Release the claim — no connector means we can't sync this
    // (but the row stays around; the operator may register one later).
    await prisma.connection.update({
      where: { id: connection.id },
      data: { lastSyncStatus: "FAILURE" },
    });
    return {
      syncRunId: "<unknown-connector>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: `No connector registered for systemCode="${connection.systemCode}"`,
    };
  }

  // 3. Open a SyncRun. (lastSyncStatus is already RUNNING from the
  // atomic claim above; no second update needed.)
  const syncRun = await prisma.syncRun.create({
    data: {
      connectionId: connection.id,
      triggerType: input.triggerType,
      cursorBefore: connection.lastCursor,
      status: "RUNNING",
    },
    select: { id: true },
  });

  // 4. Iterate fetchSince pages. Stage every record, advance cursor.
  let recordsAdded = 0;
  let recordsModified = 0;
  let recordsRemoved = 0;
  let lastCursor: string | null = connection.lastCursor;
  const allMappedLines: Array<ReturnType<typeof plaidMapperV1.map>> = [];
  const allModifiedMappedLines: Array<ReturnType<typeof plaidMapperV1.map>> = [];
  const allRemovedExternalIds: string[] = [];

  try {
    for await (const page of connector.fetchSince({
      credentials: connection.credentialsJson as Record<string, unknown>,
      cursor: connection.lastCursor,
    })) {
      // Stage raw records — frozen audit trail. createMany is bulk-insert
      // fast for the common case. Idempotency via the
      // (syncRunId, externalId) unique constraint means a retried page
      // doesn't double-stage.
      if (page.records.length > 0) {
        await prisma.importStagingRecord.createMany({
          data: page.records.map((r) => ({
            syncRunId: syncRun.id,
            externalId: r.externalId,
            recordOp: "ADDED" as const,
            rawPayload: r.raw as object,
            writeStatus: "PENDING",
          })),
          skipDuplicates: true,
        });
        recordsAdded += page.records.length;

        // Map and accumulate. For Plaid we know TRecord is PlaidTransaction
        // and the mapper output is MappedBankLine — the runner is currently
        // wired specifically for the BANK_ACCOUNT target. Future targets
        // will need their own dispatch table.
        for (const r of page.records) {
          const mapped = plaidMapperV1.map(r.raw as PlaidTransaction);
          allMappedLines.push(mapped);
        }
      }

      // Stage MODIFIED records + accumulate mapped versions for the
      // bridge call below. Recon side updates by externalRef in
      // place (line amount/description/date corrections), preserving
      // status. Operator re-reviews MATCHED lines whose amounts
      // changed via the existing UI flow.
      const modifiedRecords = page.modifiedRecords ?? [];
      if (modifiedRecords.length > 0) {
        await prisma.importStagingRecord.createMany({
          data: modifiedRecords.map((r) => ({
            syncRunId: syncRun.id,
            externalId: r.externalId,
            recordOp: "MODIFIED" as const,
            rawPayload: r.raw as object,
            writeStatus: "PENDING",
          })),
          skipDuplicates: true,
        });
        recordsModified += modifiedRecords.length;
        for (const r of modifiedRecords) {
          const mapped = plaidMapperV1.map(r.raw as PlaidTransaction);
          allModifiedMappedLines.push(mapped);
        }
      }

      // Stage REMOVED records + accumulate external IDs for the
      // bridge call below. Recon flips matching lines to VOID and
      // withdraws PROPOSED matches; APPROVED matches surface in the
      // bridge's response so the operator can decide whether to
      // reverse the JE manually.
      const removedExternalIds = page.removedExternalIds ?? [];
      if (removedExternalIds.length > 0) {
        await prisma.importStagingRecord.createMany({
          data: removedExternalIds.map((externalId) => ({
            syncRunId: syncRun.id,
            externalId,
            recordOp: "REMOVED" as const,
            rawPayload: undefined,
            writeStatus: "PENDING",
          })),
          skipDuplicates: true,
        });
        recordsRemoved += removedExternalIds.length;
        allRemovedExternalIds.push(...removedExternalIds);
      }

      lastCursor = page.nextCursor;
      if (page.nextCursor === null) break;
    }

    // 5. Promote staged records into recon as a BankStatement.
    // Threads modified + removed through to recon so corrections and
    // cancellations land alongside the new lines in one call.
    const promotion = await promoteToBankStatement({
      bankAccountId: connection.targetId,
      lines: allMappedLines,
      modifiedLines: allModifiedMappedLines,
      removedExternalIds: allRemovedExternalIds,
      syncRunId: syncRun.id,
      uploadedBy: `plaid-sync:${connection.displayName}`,
    });

    // Log approved-match warnings so the operator sees them in Vercel
    // logs without needing to dig through the SyncRun row. These are
    // matches where recon left an APPROVED reconciliation in place on
    // a now-voided bank line — the JE may need manual reversal.
    if (promotion.approvedMatchesAffected.length > 0) {
      console.warn(
        `[plaid-sync] ${connection.displayName}: ${promotion.approvedMatchesAffected.length} approved match(es) on voided lines — may need JE reversal`,
        promotion.approvedMatchesAffected
      );
    }

    // 6. Mark staged records as WRITTEN.
    if (recordsAdded > 0) {
      await prisma.importStagingRecord.updateMany({
        where: { syncRunId: syncRun.id, writeStatus: "PENDING" },
        data: {
          writeStatus: "WRITTEN",
          writtenRecordId: promotion.bankStatementId === "<empty>" || promotion.bankStatementId === "<empty-after-dedup>"
            ? null
            : promotion.bankStatementId,
          writtenAt: new Date(),
        },
      });
    }

    // 7. Close out: success.
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        completedAt: new Date(),
        status: "SUCCESS",
        cursorAfter: lastCursor,
        recordsAdded,
        recordsModified,
        recordsRemoved,
      },
    });
    await prisma.connection.update({
      where: { id: connection.id },
      data: {
        lastCursor,
        lastSyncedAt: new Date(),
        lastSyncStatus: "SUCCESS",
      },
    });

    return {
      syncRunId: syncRun.id,
      status: "SUCCESS",
      recordsAdded,
      recordsPromoted: promotion.lineCount,
      bankStatementId:
        promotion.bankStatementId.startsWith("<") ? undefined : promotion.bankStatementId,
    };
  } catch (e) {
    // 8. Close out: failure. Cursor NOT advanced — the next sync starts
    // from the same place and re-tries.
    const errorMessage = e instanceof Error ? e.message : "Unknown error";
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        completedAt: new Date(),
        status: "FAILURE",
        errorCode: "SYNC_FAILED",
        errorMessage: errorMessage.slice(0, 1000),
      },
    });
    await prisma.connection.update({
      where: { id: connection.id },
      data: { lastSyncStatus: "FAILURE" },
    });
    return {
      syncRunId: syncRun.id,
      status: "FAILURE",
      recordsAdded,
      recordsPromoted: 0,
      error: errorMessage,
    };
  }
}
