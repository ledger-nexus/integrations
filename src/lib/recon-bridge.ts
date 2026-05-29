// recon write bridge.
//
// v0.2 (current): HTTP client to recon's POST /api/internal/bank-lines
// endpoint. Mirrors ledger-core's /api/internal/journal-entries pattern.
// Closes the v0.1 "direct DB write" scoped exception.
//
// Idempotency is server-side (recon dedupes by externalRef before
// inserting). A connector that resends the same Plaid transactions
// across overlapping sync windows produces zero duplicate rows.
//
// Why bundle Plaid sync writes into a BankStatement at all (vs. just
// writing line rows)? Because recon's matching workflow + reports
// expect a BankStatement parent. We synthesize one per sync run:
//   - filename = "<format>-<runId>.json"
//   - format = "PLAID_SYNC_V1" (sender-supplied)
//   - rawPayload = JSON of the run's record set (synthesized server-side)
//   - period = min..max transaction date
//   - balances = derived from the period's signed sum (v0.1 starts at 0;
//     a full implementation would fetch Plaid /accounts/get for actual
//     balances)

import type { MappedBankLine } from "@/lib/connectors/plaid/mapper";

const DEFAULT_RECON_URL = "http://localhost:3001";

export interface PromoteToBankStatementInput {
  /** recon BankAccount.id this Plaid Connection feeds. */
  bankAccountId: string;
  /** Mapped lines from the sync run, in transaction-date order. */
  lines: MappedBankLine[];
  /**
   * MODIFIED lines (v1.2) — upstream corrections. Same shape as
   * `lines`; recon updates by externalRef in place. Empty when the
   * connector saw no corrections this sync.
   */
  modifiedLines?: MappedBankLine[];
  /**
   * REMOVED externalIds (v1.2) — upstream cancellations. Recon flips
   * matching lines to VOID. Empty when the connector saw no
   * cancellations this sync.
   */
  removedExternalIds?: string[];
  /** SyncRun.id — embedded into filename / rawPayload for audit. */
  syncRunId: string;
  /** Free-form attribution; for now "plaid-sync" — UI / dashboards use this. */
  uploadedBy?: string;
}

export interface PromoteResult {
  bankStatementId: string;
  lineCount: number;
  /** v1.2 — count of upstream corrections applied. */
  linesModified: number;
  /** v1.2 — count of upstream cancellations applied. */
  linesRemoved: number;
  /**
   * v1.2 — APPROVED matches on voided lines. Recon does not
   * auto-withdraw these (the JE may already be posted). The
   * operator needs to decide whether to reverse via ledger-core.
   */
  approvedMatchesAffected: Array<{
    externalId: string;
    bankLineId: string;
    matchId: string;
  }>;
}

export type ReconErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "UNKNOWN_BANK_ACCOUNT"
  | "INTERNAL_ERROR"
  | "TRANSPORT_ERROR";

export class ReconBridgeError extends Error {
  constructor(public code: ReconErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "ReconBridgeError";
  }
}

let _fetchOverride: typeof fetch | null = null;
export function setFetchForTesting(fn: typeof fetch | null): void {
  _fetchOverride = fn;
}

/**
 * Promote a batch of mapped Plaid transactions into recon as a new
 * BankStatement + BankStatementLines. Server-side dedup by externalRef
 * (Plaid transaction_id) guarantees idempotency across overlapping
 * sync windows.
 *
 * If the batch is empty, returns `lineCount=0` and a synthetic id —
 * the endpoint short-circuits before creating an empty BankStatement.
 */
export async function promoteToBankStatement(
  input: PromoteToBankStatementInput
): Promise<PromoteResult> {
  const modifiedLines = input.modifiedLines ?? [];
  const removedExternalIds = input.removedExternalIds ?? [];
  // Short-circuit only when there's NO work at all (no added, no
  // modified, no removed). Modify/remove-only sync runs are valid:
  // the operator might re-sync after a webhook fired about a
  // correction.
  if (
    input.lines.length === 0 &&
    modifiedLines.length === 0 &&
    removedExternalIds.length === 0
  ) {
    return {
      bankStatementId: "<empty>",
      lineCount: 0,
      linesModified: 0,
      linesRemoved: 0,
      approvedMatchesAffected: [],
    };
  }

  const baseUrl = process.env.RECON_URL ?? DEFAULT_RECON_URL;
  const token = process.env.RECON_INTERNAL_API_TOKEN;
  if (!token) {
    throw new ReconBridgeError(
      "UNAUTHORIZED",
      "RECON_INTERNAL_API_TOKEN is not set in integrations' env — cannot post to recon"
    );
  }

  function lineToWire(l: MappedBankLine) {
    return {
      externalId: l.externalId,
      transactionDate: l.transactionDate.toISOString().slice(0, 10),
      description: l.description,
      amount: l.amount.toString(),
      pending: l.pending,
    };
  }

  const body: Record<string, unknown> = {
    bankAccountId: input.bankAccountId,
    syncRunId: input.syncRunId,
    format: "PLAID_SYNC_V1",
    uploadedBy: input.uploadedBy ?? "plaid-sync",
    lines: input.lines.map(lineToWire),
  };
  if (modifiedLines.length > 0) {
    body.modifiedLines = modifiedLines.map(lineToWire);
  }
  if (removedExternalIds.length > 0) {
    body.removedExternalIds = removedExternalIds;
  }

  const fetchFn = _fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/internal/bank-lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ReconBridgeError(
      "TRANSPORT_ERROR",
      `Failed to reach recon at ${baseUrl}: ${e instanceof Error ? e.message : "Unknown error"}`
    );
  }

  type ApiResponse =
    | {
        ok: true;
        bankStatementId: string | null;
        linesCreated: number;
        linesSkipped: number;
        linesModified?: number;
        linesRemoved?: number;
        matchesWithdrawn?: number;
        approvedMatchesAffected?: Array<{
          externalId: string;
          bankLineId: string;
          matchId: string;
        }>;
        wasEmpty: boolean;
      }
    | { ok: false; error: { code: ReconErrorCode; message: string } };

  let payload: ApiResponse;
  try {
    payload = (await res.json()) as ApiResponse;
  } catch {
    throw new ReconBridgeError(
      "TRANSPORT_ERROR",
      `recon returned non-JSON response (status ${res.status})`,
      res.status
    );
  }

  if (!payload.ok) {
    throw new ReconBridgeError(payload.error.code, payload.error.message, res.status);
  }

  // Map the server-side response back to the caller's shape. The
  // caller (sync runner) wants `bankStatementId` and `lineCount`;
  // when all lines were duplicates the server returns id=null —
  // expose a synthetic marker so the runner's existing "<empty>"
  // checks still work without changes.
  return {
    bankStatementId: payload.bankStatementId ?? "<empty-after-dedup>",
    lineCount: payload.linesCreated,
    linesModified: payload.linesModified ?? 0,
    linesRemoved: payload.linesRemoved ?? 0,
    approvedMatchesAffected: payload.approvedMatchesAffected ?? [],
  };
}
