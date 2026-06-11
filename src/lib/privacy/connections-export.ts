// Integrations-side attribution for the portfolio-wide DSR export bundle.
//
// Privacy TSC. Implements the contract described at
// `docs/policies/data-subject-requests.md` → "Right of access".
//
// This function is INVOKED FROM ledger-core's `buildUserDataExport()`
// when a subject's Article 15 request is being assembled. Integrations
// is the canonical home for OAuth-based connections to upstream
// services (Plaid, etc.); this helper returns **connection metadata
// counts only**, NEVER credentials.
//
// What this returns:
//   - Counts of connections the subject created
//   - Counts by ConnectionStatus
//   - Counts by upstream system (plaid / stripe / gusto / bill_com / ...)
//   - Sync run attribution (count, NOT contents)
//
// What this NEVER returns:
//   - `Connection.credentialsJson` — OAuth access tokens, refresh
//     tokens, item-ids. These are the bank's data subject to GDPR
//     Art. 15(4) "rights of others" carve-out: the BANK is the
//     data-controller of the access-token grant, not the subject.
//     Including them would compromise the bank's risk model + violate
//     Plaid's terms.
//   - Bank transaction contents promoted to recon — those belong in
//     recon's attribution helper.
//
// Erasure-driven revocation is a SEPARATE function (not in this file)
// that calls Plaid `/item/remove` at source BEFORE nulling the local
// credentialsJson. The revocation orchestrator is the other open
// item in the DSR doc.

import { ConnectionStatus, type PrismaClient } from "@prisma/client";

/**
 * Attribution counts for a user across integrations' tables.
 *
 * Stable schema — ledger-core's export bundle persists these counts
 * verbatim. Adding a new top-level key requires a coordinated update
 * to ledger-core's `buildUserDataExport` shape and the DSR procedure.
 *
 * HARD INVARIANT: no `credentials`, `tokens`, `accessToken`, or
 * `refreshToken` fields. Enforced at compile time by
 * `tests/connections-export-stub.test.ts`.
 */
export interface ConnectionsAttribution {
  /**
   * Total connections the subject created. Counts `Connection` rows
   * whose `createdBy` matches the subject's user id. Includes
   * deactivated rows so the subject sees their full history.
   */
  connectionsCreated: number;
  /**
   * Breakdown by current `ConnectionStatus`. Lets the subject see e.g.
   * "5 active, 2 revoked, 1 paused". Always includes every enum value
   * so a downstream consumer can rely on the keys being present even
   * when zero.
   */
  connectionsByStatus: Record<ConnectionStatus, number>;
  /**
   * Sync runs initiated by the subject. Counts `SyncRun` rows whose
   * parent `Connection.createdBy` matches the subject. The run
   * contents (mapped records) stay; the count surfaces the activity.
   */
  syncRunsInitiated: number;
  /**
   * Per-system breakdown for transparency about which upstream
   * services the subject connected. Keys are `Connection.systemCode`
   * (`plaid`, `stripe`, `gusto`, `bill_com`, ...). Empty object when
   * the subject has no connections.
   */
  connectionsBySystem: Record<string, number>;
  /** When the count snapshot was taken (ISO 8601 UTC). */
  snapshotAt: string;
}

/**
 * Assemble integrations' attribution contribution to the portfolio-
 * wide DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint
 * gated by `INTERNAL_API_TOKEN`. This helper is the data-assembly
 * seam, not the authorization gate — the calling Server Action layer
 * in ledger-core owns the subject-identity verification + audit
 * emission.
 *
 * INVARIANT (enforced at the type level via `ConnectionsAttribution`):
 *   The returned object MUST NOT include `Connection.credentialsJson`
 *   in any form. The audit-log emission from the calling export path
 *   records `tokensIncluded: false` so a regulator can verify this.
 *
 * Implementation notes:
 *   - Three queries run in parallel via `Promise.all`: total count,
 *     groupBy(status), groupBy(systemCode). Each is O(connections-of-
 *     user) and the indexed selector is `createdBy`.
 *   - `connectionsByStatus` is initialized with every enum value at
 *     zero so the shape is stable regardless of which statuses the
 *     subject has used.
 *   - `syncRunsInitiated` is computed via a single count with a
 *     joined where-clause (`connection.createdBy`). Prisma compiles
 *     this to a JOIN + COUNT.
 *
 * @param prisma - Prisma client (typically the integrations singleton)
 * @param userId - Subject user UUID. Matched against `Connection.createdBy`.
 * @returns Attribution counts. Empty-but-valid shape if the subject
 *          has no connections.
 */
export async function connectionsAttribution(
  prisma: PrismaClient,
  userId: string
): Promise<ConnectionsAttribution> {
  const [connectionsCreated, statusGroups, systemGroups, syncRunsInitiated] =
    await Promise.all([
      prisma.connection.count({ where: { createdBy: userId } }),
      prisma.connection.groupBy({
        by: ["status"],
        where: { createdBy: userId },
        _count: { _all: true },
      }),
      prisma.connection.groupBy({
        by: ["systemCode"],
        where: { createdBy: userId },
        _count: { _all: true },
      }),
      prisma.syncRun.count({
        where: { connection: { createdBy: userId } },
      }),
    ]);

  // Initialize every status key at zero so the shape is stable.
  const connectionsByStatus: Record<ConnectionStatus, number> = {
    [ConnectionStatus.ACTIVE]: 0,
    [ConnectionStatus.PAUSED]: 0,
    [ConnectionStatus.REVOKED]: 0,
    [ConnectionStatus.ERROR]: 0,
  };
  for (const g of statusGroups) {
    connectionsByStatus[g.status] = g._count._all;
  }

  const connectionsBySystem: Record<string, number> = {};
  for (const g of systemGroups) {
    connectionsBySystem[g.systemCode] = g._count._all;
  }

  return {
    connectionsCreated,
    connectionsByStatus,
    syncRunsInitiated,
    connectionsBySystem,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Retained for backwards compatibility with the v0.1 typed-stub
 * tests. Real callers will not see this thrown — the implementation
 * above is now wired. The class export stays so callers that catch
 * it specifically (legacy code paths) continue to compile.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
