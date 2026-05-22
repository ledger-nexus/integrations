// Sync runner — the orchestrator that takes a Connection, calls the
// connector's fetchSince, normalizes via the mapper, stages, and
// promotes to recon.
//
// v0.1 is synchronous: one runConnectionSync call processes the full
// cursor-advance loop and returns when done. v0.2 will move this to a
// background job queue (pg_boss) and split it into per-page handlers
// so a long sync doesn't tie up a Server Action's request thread.
//
// Per-connection lock: simple "is the connection already syncing?"
// guard via the lastSyncStatus column. Two concurrent sync attempts
// would corrupt the cursor — we refuse the second one and let it
// retry after the first completes.

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
  // 1. Load the connection + check it's actionable.
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
    return {
      syncRunId: "<missing>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: "Connection not found",
    };
  }
  if (connection.status !== "ACTIVE") {
    return {
      syncRunId: "<skipped>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: `Connection status=${connection.status} — sync skipped`,
    };
  }
  if (connection.lastSyncStatus === "RUNNING") {
    return {
      syncRunId: "<locked>",
      status: "SKIPPED_LOCKED",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: "Another sync is already in progress for this connection",
    };
  }
  if (connection.targetType !== "BANK_ACCOUNT" || !connection.targetId) {
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
    return {
      syncRunId: "<unknown-connector>",
      status: "FAILURE",
      recordsAdded: 0,
      recordsPromoted: 0,
      error: `No connector registered for systemCode="${connection.systemCode}"`,
    };
  }

  // 2. Open a SyncRun + flip status to RUNNING.
  const syncRun = await prisma.syncRun.create({
    data: {
      connectionId: connection.id,
      triggerType: input.triggerType,
      cursorBefore: connection.lastCursor,
      status: "RUNNING",
    },
    select: { id: true },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncStatus: "RUNNING" },
  });

  // 3. Iterate fetchSince pages. Stage every record, advance cursor.
  let recordsAdded = 0;
  let lastCursor: string | null = connection.lastCursor;
  const allMappedLines: Array<ReturnType<typeof plaidMapperV1.map>> = [];

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
      lastCursor = page.nextCursor;
      if (page.nextCursor === null) break;
    }

    // 4. Promote staged records into recon as a BankStatement.
    const promotion = await promoteToBankStatement({
      bankAccountId: connection.targetId,
      lines: allMappedLines,
      syncRunId: syncRun.id,
      uploadedBy: `plaid-sync:${connection.displayName}`,
    });

    // 5. Mark staged records as WRITTEN.
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

    // 6. Close out: success.
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        completedAt: new Date(),
        status: "SUCCESS",
        cursorAfter: lastCursor,
        recordsAdded,
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
    // 7. Close out: failure. Cursor NOT advanced — the next sync starts
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
