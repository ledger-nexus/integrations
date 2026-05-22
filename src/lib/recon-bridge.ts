// recon write bridge. v0.1 writes directly to recon's BankStatement +
// BankStatementLine tables via the shared Postgres database (mirror
// approach — same as recon and revenue-rec writing to their owned
// tables in their own schemas, since all three repos share one DB).
//
// v0.2 will refactor to POST to a recon internal HTTP endpoint
// (mirror of ledger-core's /api/internal/journal-entries), making
// integrations a clean API consumer of recon. The function signatures
// here are shaped so the refactor changes the implementation without
// touching callers.
//
// Why bundle Plaid sync writes into a BankStatement at all (vs. just
// writing line rows)? Because recon's matching workflow + reports
// expect a BankStatement parent. We synthesize one per sync run:
//   - filename = "plaid-sync-<runId>.json"
//   - format = "PLAID_SYNC_V1"
//   - rawPayload = JSON of the sync run's record set
//   - period = min..max transaction date
//   - balances = derived from the period's running sum (v0.1 starts at 0;
//     a full implementation would fetch Plaid /accounts/get for actual
//     balances)

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import type { MappedBankLine } from "@/lib/connectors/plaid/mapper";

export interface PromoteToBankStatementInput {
  /** recon BankAccount.id this Plaid Connection feeds. */
  bankAccountId: string;
  /** Mapped lines from the sync run, in transaction-date order. */
  lines: MappedBankLine[];
  /** SyncRun.id — embedded into filename / rawPayload for audit. */
  syncRunId: string;
  /** Free-form attribution; for now "plaid-sync" — UI / dashboards use this. */
  uploadedBy?: string;
}

export interface PromoteResult {
  bankStatementId: string;
  lineCount: number;
}

/**
 * Promote a batch of mapped Plaid transactions into a new recon
 * BankStatement + BankStatementLines. Idempotent at the per-record
 * level via externalRef (the Plaid transaction_id) — re-running a
 * sync with overlapping records does NOT create duplicates.
 *
 * Implementation note: when the batch is empty (zero new transactions
 * since cursor), we DO NOT create an empty BankStatement. Returns
 * lineCount=0 and a synthetic id.
 */
export async function promoteToBankStatement(
  input: PromoteToBankStatementInput
): Promise<PromoteResult> {
  if (input.lines.length === 0) {
    return { bankStatementId: "<empty>", lineCount: 0 };
  }

  // 1. Sort + derive period bounds.
  const sorted = [...input.lines].sort(
    (a, b) => a.transactionDate.getTime() - b.transactionDate.getTime()
  );
  const periodStart = sorted[0].transactionDate;
  const periodEnd = sorted[sorted.length - 1].transactionDate;

  // 2. Compute simple running balance. v0.1 starts the synthesized
  // statement at opening = 0; closing = sum of signed amounts. This
  // doesn't match the bank's actual opening — the matcher doesn't
  // care, but reports do. v0.2 will fetch Plaid /accounts/get for
  // real balances.
  const sumSigned = sorted.reduce(
    (acc, l) => acc.plus(l.amount),
    new Decimal(0)
  );

  // 3. Filter out records that ALREADY exist (idempotency). recon's
  // BankStatementLine has externalRef which we populate with the Plaid
  // transaction_id. Existing rows are skipped — the batch shrinks.
  const externalIds = sorted.map((l) => l.externalId);
  const alreadyImported = await prisma.bankStatementLine.findMany({
    where: { externalRef: { in: externalIds } },
    select: { externalRef: true },
  });
  const seenIds = new Set(
    alreadyImported.map((r) => r.externalRef).filter((x): x is string => !!x)
  );
  const fresh = sorted.filter((l) => !seenIds.has(l.externalId));

  if (fresh.length === 0) {
    return { bankStatementId: "<empty-after-dedup>", lineCount: 0 };
  }

  // 4. Write the BankStatement + lines in one transaction.
  const filename = `plaid-sync-${input.syncRunId.slice(0, 8)}.json`;
  const rawPayload = JSON.stringify(
    fresh.map((l) => ({
      externalId: l.externalId,
      date: l.transactionDate.toISOString().slice(0, 10),
      amount: l.amount.toString(),
      description: l.description,
      pending: l.pending,
    })),
    null,
    2
  );

  const statement = await prisma.bankStatement.create({
    data: {
      bankAccountId: input.bankAccountId,
      filename,
      format: "PLAID_SYNC_V1",
      rawPayload,
      uploadedBy: input.uploadedBy ?? "plaid-sync",
      periodStart,
      periodEnd,
      openingBalance: "0.0000",
      closingBalance: sumSigned.toFixed(4),
      totalLines: fresh.length,
      matchedLines: 0,
      pendingLines: fresh.length,
      lines: {
        create: fresh.map((l, idx) => ({
          lineNo: idx + 1,
          transactionDate: l.transactionDate,
          description: l.description,
          amount: l.amount.toFixed(4),
          externalRef: l.externalId,
          status: "UNMATCHED",
        })),
      },
    },
    select: { id: true },
  });

  return { bankStatementId: statement.id, lineCount: fresh.length };
}
