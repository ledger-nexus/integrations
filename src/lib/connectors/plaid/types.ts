// Plaid record shapes — narrow subset of what the SDK returns. We
// only model what our mapper actually consumes. Full Plaid SDK types
// live in `plaid` package; importing them transitively pulls in the
// whole API surface, which makes IDE autocomplete heavier than
// necessary. This file is the typed contract for the mapper.
//
// Source: Plaid API reference — https://plaid.com/docs/api/products/transactions/

/**
 * Credentials persisted to Connection.credentialsJson for a Plaid
 * connection. accessToken is the long-lived secret; never log it.
 */
export interface PlaidCredentials {
  /** Long-lived access token returned from /item/public_token/exchange. */
  accessToken: string;
  /** Plaid Item identifier — the "connected account" abstraction. */
  itemId: string;
  /** Institution metadata captured at link time for display + branding. */
  institutionId?: string;
  institutionName?: string;
  /**
   * If the user selected a specific account during Link (single-account
   * flow), the Plaid account_id. Multi-account Items can carry this
   * separately per Connection row.
   */
  accountId?: string;
}

/**
 * Plaid's /transactions/sync response shape — what the engine receives
 * per page. The full Plaid type has many more fields; we pull only what
 * the mapper needs.
 */
export interface PlaidTransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
}

/**
 * A Plaid Transaction. Subset of the full schema; see
 * https://plaid.com/docs/api/products/transactions/#transactions-get-response-transactions
 */
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /**
   * Posted amount in the account's currency. Plaid signs OPPOSITE to
   * the convention we use downstream:
   *   - Plaid: positive = OUTFLOW (money leaving the account, e.g., charges)
   *   - recon: positive = INFLOW (deposits)
   * The mapper flips the sign.
   */
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  /** ISO date string for when the transaction posted. */
  date: string;
  /** ISO datetime for when Plaid first saw it (often null for posted txns). */
  datetime?: string | null;
  /** ISO date for when the transaction was authorized (pre-post). */
  authorized_date?: string | null;
  /** Plaid's cleaned, normalized merchant/description. */
  name: string;
  /** Original bank-provided description. */
  original_description?: string | null;
  /** Merchant name when Plaid identifies a known merchant. */
  merchant_name?: string | null;
  /** Pending posts can change; we surface but don't act on these in v0.1. */
  pending: boolean;
  /**
   * Plaid's category hierarchy (deprecated in favor of `personal_finance_category`).
   * Kept for v0.1; v0.2+ should migrate.
   */
  category?: string[] | null;
  /** Account owner type (consumer / business). */
  account_owner?: string | null;
}

export interface PlaidRemovedTransaction {
  transaction_id: string;
}

/**
 * Plaid Item account metadata — returned by /accounts/get. Used at
 * connect time to display the user's account selections.
 */
export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  type: string;       // depository, credit, loan, investment, other
  subtype?: string | null; // checking, savings, credit card, etc.
  mask?: string | null;   // last 4 of account number
  balances?: {
    available?: number | null;
    current?: number | null;
    iso_currency_code?: string | null;
  };
}

/**
 * Plaid's JWK shape as returned by /webhook_verification_key/get.
 * Plaid signs webhooks with ES256 (ECDSA over P-256 + SHA-256), so the
 * key is an EC public key with x/y coordinates.
 *
 * `expired_at` is a Unix timestamp (seconds). If set and in the past,
 * Plaid has rotated past this key — but in-flight retries of older
 * webhooks may still arrive and remain valid for a short window.
 * Verification logic treats null `expired_at` as "current key".
 */
export interface PlaidWebhookVerificationKey {
  alg: string;        // "ES256"
  crv: string;        // "P-256"
  kid: string;
  kty: string;        // "EC"
  use: string;        // "sig"
  x: string;          // base64url-encoded EC x coordinate
  y: string;          // base64url-encoded EC y coordinate
  created_at: number; // unix seconds
  expired_at: number | null;
}
