// Plaid Transaction → recon BankStatementLine mapping.
//
// Pure function; no I/O. Lives separately from the connector so it's
// trivially unit-testable. mapperVersion is logged on every mapped row
// so a future change to mapping logic doesn't silently rewrite history —
// staged records know which mapper version produced them.
//
// Key transformation: SIGN FLIP.
//
//   Plaid amount convention:
//     positive = OUTFLOW (charges, debits leaving the account)
//     negative = INFLOW (deposits, credits arriving)
//
//   recon BankStatementLine.amount convention:
//     positive = INFLOW (deposit)
//     negative = OUTFLOW (withdrawal)
//
//   So mapped.amount = -plaid.amount. The mapper documents this with a
//   comment because it's the most error-prone bit.

import { Decimal } from "decimal.js";
import type { PlaidTransaction } from "./types";
import type { ConnectorMapper } from "../interface";

/**
 * The shape we emit for downstream consumption. Matches recon's
 * BankStatementLine inputs, plus the externalId for idempotency
 * tracking on the integrations side. The sync runner uses this to
 * call recon's write API.
 */
export interface MappedBankLine {
  /** Plaid transaction_id — used for idempotency / dedup. */
  externalId: string;
  /** Plaid account_id — used to dispatch to the right BankStatementLine.statement. */
  externalAccountId: string;
  /** Trade/post date (positive currency direction with our sign convention). */
  transactionDate: Date;
  /** Description shown to the user. Falls back through Plaid's options. */
  description: string;
  /**
   * Signed amount with recon's convention (positive=inflow).
   * The mapper flips Plaid's opposite sign.
   */
  amount: Decimal;
  /** Currency. Falls back to USD if Plaid omits. */
  currencyCode: string;
  /** Pending posts may shift; downstream policy is to ignore for v0.1. */
  pending: boolean;
  /** Plaid's normalized merchant (when known). Useful audit context. */
  merchantName: string | null;
  /** Plaid's category hierarchy (legacy). Captured for audit; not used by recon's matcher v0.1. */
  category: string[] | null;
}

export const plaidMapperV1: ConnectorMapper<PlaidTransaction, MappedBankLine> = {
  mapperVersion: "plaid-mapper-v1",
  map(raw: PlaidTransaction): MappedBankLine {
    // Sign flip: Plaid positive=outflow → our positive=inflow.
    // -100.50 in Plaid (a deposit) becomes +100.50 in our schema.
    const amount = new Decimal(raw.amount).negated();

    // Description preference: Plaid's cleaned `name` first, then the
    // bank's `original_description`, then `merchant_name`. Plaid's
    // `name` is the highest-quality string in most cases.
    const description =
      raw.name ||
      raw.original_description ||
      raw.merchant_name ||
      `Plaid txn ${raw.transaction_id.slice(0, 8)}`;

    // Currency. Plaid returns either iso_currency_code or
    // unofficial_currency_code (for crypto / foreign / oddities).
    // Default to USD when both are null — sandbox sometimes omits.
    const currencyCode =
      raw.iso_currency_code ??
      raw.unofficial_currency_code ??
      "USD";

    // Transaction date. Plaid's `date` is YYYY-MM-DD (the post date).
    // We construct as UTC midnight to avoid timezone drift on
    // Date.toISOString() / @db.Date storage.
    const transactionDate = new Date(`${raw.date}T00:00:00.000Z`);

    return {
      externalId: raw.transaction_id,
      externalAccountId: raw.account_id,
      transactionDate,
      description,
      amount,
      currencyCode,
      pending: raw.pending,
      merchantName: raw.merchant_name ?? null,
      category: raw.category ?? null,
    };
  },
};
