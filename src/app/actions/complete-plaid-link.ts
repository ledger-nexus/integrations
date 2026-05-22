"use server";

// Server Action called from <PlaidLinkButton />'s onSuccess. Exchanges
// the public_token for a long-lived access_token, fetches Plaid's
// account metadata, and creates a Connection row pointing at the
// recon BankAccount the user selected.
//
// The bankAccountId comes from the Connect form — the user picks which
// of their already-seeded recon BankAccount rows this Plaid feed
// should land in. A future enhancement: auto-create a new
// BankAccount when none exists yet (requires ledger-core's Account
// chart to know about it, so out of scope for v0.1).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { plaidConnector } from "@/lib/connectors/plaid/connector";
import { runConnectionSync } from "@/lib/sync/runner";

export interface CompletePlaidLinkInput {
  /** Plaid Link's onSuccess callback gives us this. */
  publicToken: string;
  /** Plaid metadata about the selected account (from onSuccess metadata). */
  selectedAccountId?: string;
  /** Which recon BankAccount this feed lands in. */
  bankAccountId: string;
  /** Optional initial sync — pull transactions immediately. Default true. */
  initialSync?: boolean;
}

export interface CompletePlaidLinkState {
  ok: boolean;
  connectionId?: string;
  bankStatementId?: string;
  recordsAdded?: number;
  message?: string;
}

export async function completePlaidLinkAction(
  input: CompletePlaidLinkInput
): Promise<CompletePlaidLinkState> {
  try {
    if (!input.publicToken) {
      return { ok: false, message: "publicToken required" };
    }
    if (!input.bankAccountId) {
      return { ok: false, message: "bankAccountId required" };
    }

    // 1. Verify the target BankAccount exists.
    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: input.bankAccountId },
      select: { id: true, code: true, displayName: true },
    });
    if (!bankAccount) {
      return { ok: false, message: "Target BankAccount not found in recon" };
    }

    // 2. Exchange the public_token + persist credentials.
    const auth = await plaidConnector.completeAuth({
      callbackParams: {
        publicToken: input.publicToken,
        accountId: input.selectedAccountId,
      },
    });

    // 3. Create the Connection row. Unique(systemCode, targetId) so
    // the same BankAccount can't have two Plaid feeds — re-running
    // Connect on an existing pair would error. v0.2 could offer
    // "replace existing connection?" UX.
    const connection = await prisma.connection.create({
      data: {
        systemCode: "plaid",
        displayName: auth.displayName,
        status: "ACTIVE",
        targetType: "BANK_ACCOUNT",
        targetId: bankAccount.id,
        credentialsJson: auth.credentials as object,
        createdBy: "integrations-dev-user",
      },
      select: { id: true },
    });

    // 4. Optional initial sync. Most users want their transactions
    // pulled immediately rather than waiting for the first scheduled
    // run.
    let initialSyncResult: { bankStatementId?: string; recordsAdded?: number } = {};
    if (input.initialSync !== false) {
      const sync = await runConnectionSync({
        connectionId: connection.id,
        triggerType: "MANUAL",
      });
      initialSyncResult = {
        bankStatementId: sync.bankStatementId,
        recordsAdded: sync.recordsAdded,
      };
    }

    revalidatePath("/connections");
    revalidatePath("/");
    return {
      ok: true,
      connectionId: connection.id,
      ...initialSyncResult,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error completing Plaid Link",
    };
  }
}
