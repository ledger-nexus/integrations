// The Plaid connector. Implements the Connector interface using the
// Plaid client wrapper.
//
// Pull flow:
//   1. The user runs Plaid Link in the browser; gets a public_token
//   2. Server calls initiateAuth → linkToken (server-side)
//   3. Plaid Link returns public_token via its onSuccess callback
//   4. Server calls completeAuth → exchange public_token → access_token
//   5. Server persists Connection with the access_token as credentials
//   6. Later (manual sync, scheduled job, or webhook), the sync runner
//      calls fetchSince with the persisted cursor; the connector
//      streams pages of Plaid Transactions
//   7. Mapper transforms each Transaction into a MappedBankLine
//   8. Engine writes to staging then promotes to recon's BankStatementLine

import {
  createLinkToken,
  exchangePublicToken,
  getItemInfo,
  getAccounts,
  transactionsSync,
} from "./client";
import { verifyPlaidWebhook } from "./webhook-verification";
import type { PlaidCredentials, PlaidTransaction } from "./types";
import type {
  Connector,
  ConnectorMeta,
  ConnectorCredentials,
  InitiateAuthInput,
  InitiateAuthResult,
  CompleteAuthInput,
  CompleteAuthResult,
  FetchSinceInput,
  FetchPage,
  ParseWebhookInput,
  ParseWebhookResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "../interface";

const META: ConnectorMeta = {
  systemCode: "plaid",
  displayName: "Plaid (bank feeds)",
  targetType: "BANK_ACCOUNT",
  capabilities: {
    polling: true,
    // Webhook receivers (v0.2). Plaid fires TRANSACTIONS webhooks
    // (SYNC_UPDATES_AVAILABLE for the modern /transactions/sync flow,
    // DEFAULT_UPDATE for the legacy flow). The receiver lives at
    // /api/plaid/webhook and parseWebhookEvent below converts the
    // payload into the engine's "needs immediate fetch" signal.
    webhook: true,
    // Push (writing back to Plaid) isn't a thing — Plaid is read-only.
    push: false,
  },
};

function asPlaidCreds(c: ConnectorCredentials): PlaidCredentials {
  // Cast the opaque credentials blob to our typed shape. The engine
  // persists whatever we returned from completeAuth, so this cast is
  // safe as long as we don't reshape the type without migrating
  // existing Connection rows.
  return c as unknown as PlaidCredentials;
}

/**
 * Internal helper for completeAuth — handles the Plaid public→access
 * exchange + item info + account picking. Exposed for tests that want
 * to stub out the Plaid SDK and feed in pre-baked credentials.
 */
async function buildCredentialsFromPublicToken(
  publicToken: string,
  preferredAccountId?: string
): Promise<{ credentials: PlaidCredentials; displayName: string; externalAccountId?: string }> {
  // 1. Exchange the public_token for a long-lived access_token.
  const { accessToken, itemId } = await exchangePublicToken(publicToken);

  // 2. Fetch institution metadata for display.
  const itemInfo = await getItemInfo(accessToken);

  // 3. Fetch accounts. Plaid Items can have multiple sub-accounts
  // (checking + savings + credit card). v0.1 default: if the user
  // didn't pre-select, pick the first depository account. The UI
  // surfaces a picker if more than one matches.
  const accounts = await getAccounts(accessToken);
  const selected =
    accounts.find((a) => a.account_id === preferredAccountId) ??
    accounts.find((a) => a.type === "depository") ??
    accounts[0];

  if (!selected) {
    throw new Error("Plaid Item returned no accounts — cannot create Connection");
  }

  const credentials: PlaidCredentials = {
    accessToken,
    itemId,
    institutionId: itemInfo.institutionId,
    institutionName: itemInfo.institutionName,
    accountId: selected.account_id,
  };

  const bankName = itemInfo.institutionName ?? "Bank";
  const accountLabel = selected.name ?? selected.subtype ?? "account";
  const mask = selected.mask ? ` ****${selected.mask}` : "";
  const displayName = `${bankName} — ${accountLabel}${mask}`;

  return {
    credentials,
    displayName,
    externalAccountId: selected.account_id,
  };
}

export const plaidConnector: Connector<PlaidTransaction> = {
  meta: META,

  async initiateAuth(input: InitiateAuthInput): Promise<InitiateAuthResult> {
    const res = await createLinkToken({
      userId: input.actorUserId,
      clientName: "ledger-nexus / integrations",
    });
    return {
      linkToken: res.linkToken,
    };
  },

  async completeAuth(input: CompleteAuthInput): Promise<CompleteAuthResult> {
    // Plaid Link's onSuccess gives us a public_token and metadata.
    // Our Server Action forwards both as callbackParams.
    const publicToken = input.callbackParams.publicToken as string | undefined;
    if (!publicToken) {
      throw new Error(
        "completeAuth: missing publicToken (expected from Plaid Link onSuccess)"
      );
    }
    const preferredAccountId = input.callbackParams.accountId as string | undefined;
    const { credentials, displayName, externalAccountId } =
      await buildCredentialsFromPublicToken(publicToken, preferredAccountId);
    return {
      credentials: credentials as unknown as ConnectorCredentials,
      displayName,
      externalAccountId,
      metadata: {
        institutionId: credentials.institutionId,
        institutionName: credentials.institutionName,
      },
    };
  },

  /**
   * Stream pages of Plaid transactions since the cursor. Implementation
   * uses Plaid's /transactions/sync — cursor-based, no missing/duplicate
   * transactions, no period management needed. We yield pages as the
   * connector receives them; the engine pages through and persists
   * incremental cursor progress between batches.
   */
  async *fetchSince(input: FetchSinceInput): AsyncIterable<FetchPage<PlaidTransaction>> {
    const creds = asPlaidCreds(input.credentials);
    let cursor: string | null = input.cursor;

    // Plaid's has_more signals when there's another page. Loop until exhausted.
    while (true) {
      const response = await transactionsSync({
        accessToken: creds.accessToken,
        cursor,
      });

      // Build the page. v0.1 ignores `modified` and `removed` — the
      // matcher in recon can't yet handle retro-updates to imported
      // transactions. Adding that is a v0.2 enhancement; for now the
      // engine fast-paths the simpler add-only case. Tracked in
      // docs/adding-a-connector.md.
      const records = response.added
        // Filter accounts we don't care about (Plaid Items can have
        // multiple; this Connection targets a specific one).
        .filter((t) => !creds.accountId || t.account_id === creds.accountId)
        .map((t) => ({ externalId: t.transaction_id, raw: t }));

      yield {
        records,
        nextCursor: response.has_more ? response.next_cursor : null,
      };

      if (!response.has_more) break;
      cursor = response.next_cursor;
    }
  },

  /**
   * Parse a Plaid webhook payload. Plaid's transactions webhooks are
   * NOTIFICATIONS — they signal "new transactions available" rather
   * than carrying the records themselves. So this returns an empty
   * records array and sets needsImmediateFetch=true, which the engine
   * uses to trigger an immediate fetchSince() against the cursor.
   *
   * The route handler (/api/plaid/webhook) is responsible for matching
   * the payload's item_id to a Connection BEFORE calling this — the
   * connector itself is item-agnostic.
   *
   * Webhook codes handled:
   *   - TRANSACTIONS / SYNC_UPDATES_AVAILABLE (modern /transactions/sync)
   *   - TRANSACTIONS / DEFAULT_UPDATE (legacy)
   *   - TRANSACTIONS / INITIAL_UPDATE, HISTORICAL_UPDATE (first-time
   *     sync ready; same response — trigger fetch)
   *
   * Codes that don't trigger a sync:
   *   - TRANSACTIONS_REMOVED — handled by the next /transactions/sync
   *     call returning removed records (the route handler may still
   *     trigger an immediate sync to flush them)
   *   - ITEM / ERROR — handled in the route handler (mark connection
   *     ERROR), not here
   */
  /**
   * Verify the JWT in the `Plaid-Verification` header. Delegates to
   * webhook-verification.ts which:
   *   - decodes the ES256 JWT
   *   - fetches the matching JWK from Plaid (in-process cached by kid)
   *   - confirms iat is within Plaid's 5-min replay window
   *   - confirms the request body SHA-256 matches the signed claim
   *
   * Returns `{ ok: true, kid }` on success or `{ ok: false, reason }` so
   * the route handler can audit-log specifically why a request was
   * rejected (stale iat vs bad sig vs body tampered).
   */
  verifyWebhookSignature(
    input: VerifyWebhookInput
  ): Promise<VerifyWebhookResult> {
    return verifyPlaidWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
    });
  },

  parseWebhookEvent(
    input: ParseWebhookInput<PlaidTransaction>
  ): Promise<ParseWebhookResult<PlaidTransaction>> {
    const body = input.body as
      | {
          webhook_type?: string;
          webhook_code?: string;
        }
      | null;

    if (!body || typeof body !== "object") {
      return Promise.resolve({ records: [], needsImmediateFetch: false });
    }

    const isTransactionsSync =
      body.webhook_type === "TRANSACTIONS" &&
      (body.webhook_code === "SYNC_UPDATES_AVAILABLE" ||
        body.webhook_code === "DEFAULT_UPDATE" ||
        body.webhook_code === "INITIAL_UPDATE" ||
        body.webhook_code === "HISTORICAL_UPDATE" ||
        body.webhook_code === "TRANSACTIONS_REMOVED");

    return Promise.resolve({
      records: [],
      needsImmediateFetch: isTransactionsSync,
    });
  },

  // No refresh needed — Plaid access_tokens don't expire. (Items can
  // become invalid if the user revokes access at their bank, but
  // that surfaces as an API error on the next fetchSince call.)
};

// Re-export the internal helper for unit tests that want to feed in
// a synthesized public_token. NOT meant for application use.
export const _internal = {
  buildCredentialsFromPublicToken,
};
