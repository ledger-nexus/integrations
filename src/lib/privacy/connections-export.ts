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
//   - Sync history attribution (count, NOT contents)
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

import type { PrismaClient, ConnectionStatus } from "@prisma/client";

/**
 * Attribution counts for a user across integrations' tables.
 *
 * Stable schema — once shipped, ledger-core's export bundle will
 * persist these counts.
 */
export interface ConnectionsAttribution {
  /**
   * Total connections the subject created. Counts the `Connection`
   * rows whose attribution chain ends at this userId.
   */
  connectionsCreated: number;
  /**
   * Breakdown by current status. Lets the subject see e.g. "5 active,
   * 2 revoked, 1 paused".
   */
  connectionsByStatus: Record<ConnectionStatus, number>;
  /**
   * Sync runs initiated by the subject. Counts `SyncRun` rows
   * attributable to the user. The run contents (mapped records)
   * stay; the count surfaces the activity.
   */
  syncRunsInitiated: number;
  /**
   * Per-system breakdown for transparency about which upstream
   * services the subject connected. Keys are `Connection.systemCode`
   * (plaid, stripe, gusto, bill_com, ...).
   */
  connectionsBySystem: Record<string, number>;
  /** When the count snapshot was taken. */
  snapshotAt: string;
}

/**
 * Assemble integrations' attribution contribution to the portfolio-
 * wide DSR export bundle.
 *
 * Caller: `ledger-core/src/lib/privacy/user-data.ts buildUserDataExport()`.
 * Called via HTTP at a future `/api/internal/dsr/attribution` endpoint.
 *
 * Authorization: enforced at the calling Server Action layer in
 * ledger-core. This helper is the data-assembly seam, not the
 * authorization gate.
 *
 * INVARIANT (enforced at implementation time):
 *   The returned object MUST NOT include `Connection.credentialsJson`
 *   in any form. The audit-log emission from the calling export path
 *   records `tokensIncluded: false` so a regulator can verify this.
 *
 * @throws NotImplementedError — body not yet written. Triggered when
 *         the first real DSR arrives.
 */
export async function connectionsAttribution(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string
): Promise<ConnectionsAttribution> {
  throw new NotImplementedError(
    "connectionsAttribution is a typed stub. See " +
      "docs/policies/data-subject-requests.md → \"Open items\" for " +
      "the implementation trigger."
  );
}

/**
 * Distinct error class so a real-DSR caller can catch this specifically
 * vs. an unexpected error (e.g., DB outage) and surface the right
 * message to the privacy lead.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
