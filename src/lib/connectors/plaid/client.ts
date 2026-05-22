// Thin wrapper around Plaid's Node SDK. Centralizes:
//   - Configuration (env-driven; one client instance per process)
//   - Test override for unit tests
//   - Error normalization (Plaid throws axios-style errors; we surface a
//     consistent shape)
//
// The full Plaid SDK surface is huge; this file exposes only the methods
// our connector uses. Adding a Plaid product (auth, identity, balance)
// = adding methods here.
//
// Sandbox vs production: PLAID_ENV switches the base URL. Sandbox is
// free and returns test data; production starts at ~$0.30/connected
// account. We always default to sandbox for safety in dev.

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  CountryCode,
  Products,
} from "plaid";
import type {
  PlaidTransaction,
  PlaidTransactionsSyncResponse,
  PlaidAccount,
} from "./types";

let _clientOverride: PlaidApi | null = null;

/**
 * Get the configured Plaid client. Throws if env vars aren't set —
 * Server Actions catch this and surface to the UI.
 */
export function getPlaidClient(): PlaidApi {
  if (_clientOverride) return _clientOverride;

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV ?? "sandbox";

  if (!clientId) throw new Error("PLAID_CLIENT_ID not set");
  if (!secret) throw new Error("PLAID_SECRET not set");
  const basePath = PlaidEnvironments[env as keyof typeof PlaidEnvironments];
  if (!basePath) {
    throw new Error(
      `Unknown PLAID_ENV="${env}". Use sandbox | development | production.`
    );
  }

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
}

/** Test seam — inject a mock PlaidApi. Production callers don't use this. */
export function setPlaidClientForTesting(client: PlaidApi | null): void {
  _clientOverride = client;
}

/** Parse PLAID_PRODUCTS env var. Defaults to transactions only. */
export function getConfiguredProducts(): Products[] {
  const raw = process.env.PLAID_PRODUCTS ?? "transactions";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s as Products);
}

/** Parse PLAID_COUNTRY_CODES env var. Defaults to US. */
export function getConfiguredCountryCodes(): CountryCode[] {
  const raw = process.env.PLAID_COUNTRY_CODES ?? "US";
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)
    .map((s) => s as CountryCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plaid API operations (the methods the connector uses)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a link_token for the Plaid Link client widget. Called from
 * the server when a user starts the Connect flow.
 */
export async function createLinkToken(input: {
  userId: string;
  clientName: string;
}): Promise<{ linkToken: string; expiration: string }> {
  const client = getPlaidClient();
  const res = await client.linkTokenCreate({
    user: { client_user_id: input.userId },
    client_name: input.clientName,
    products: getConfiguredProducts(),
    country_codes: getConfiguredCountryCodes(),
    language: "en",
  });
  return {
    linkToken: res.data.link_token,
    expiration: res.data.expiration,
  };
}

/**
 * Exchange the public_token (from Plaid Link's onSuccess callback)
 * for a long-lived access_token. The access_token never leaves our
 * server; the public_token is short-lived (~30 min) and useless on
 * its own.
 */
export async function exchangePublicToken(publicToken: string): Promise<{
  accessToken: string;
  itemId: string;
}> {
  const client = getPlaidClient();
  const res = await client.itemPublicTokenExchange({
    public_token: publicToken,
  });
  return {
    accessToken: res.data.access_token,
    itemId: res.data.item_id,
  };
}

/**
 * Fetch institution metadata so we can display the bank's name + logo.
 */
export async function getItemInfo(
  accessToken: string
): Promise<{ institutionId?: string; institutionName?: string }> {
  const client = getPlaidClient();
  try {
    const itemRes = await client.itemGet({ access_token: accessToken });
    const institutionId = itemRes.data.item.institution_id;
    if (!institutionId) return {};
    const instRes = await client.institutionsGetById({
      institution_id: institutionId,
      country_codes: getConfiguredCountryCodes(),
    });
    return {
      institutionId,
      institutionName: instRes.data.institution.name,
    };
  } catch {
    // Best-effort: if Plaid can't return institution info, the Connection
    // still works — we just won't show the bank name.
    return {};
  }
}

/**
 * Fetch the list of accounts for an Item. Used at connect time to pick
 * which specific account this Connection maps to (Plaid Items can have
 * multiple sub-accounts: checking + savings + credit card).
 */
export async function getAccounts(accessToken: string): Promise<PlaidAccount[]> {
  const client = getPlaidClient();
  const res = await client.accountsGet({ access_token: accessToken });
  return res.data.accounts as unknown as PlaidAccount[];
}

/**
 * /transactions/sync — cursor-based transaction stream. Each call
 * returns the next batch of added/modified/removed transactions since
 * the cursor. has_more=true means we should call again with the
 * returned next_cursor.
 */
export async function transactionsSync(input: {
  accessToken: string;
  cursor: string | null;
  /** Cap per page. Plaid maxes 500; we default lower for memory. */
  count?: number;
}): Promise<PlaidTransactionsSyncResponse> {
  const client = getPlaidClient();
  const res = await client.transactionsSync({
    access_token: input.accessToken,
    cursor: input.cursor ?? undefined,
    count: input.count ?? 100,
  });
  return res.data as unknown as PlaidTransactionsSyncResponse;
}
