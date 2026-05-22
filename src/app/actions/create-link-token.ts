"use server";

// Server Action that mints a Plaid Link token. Called from the Connect
// page's <PlaidLinkButton /> client component — Plaid Link opens
// directly with this token; no further server round trip needed until
// the user finishes the bank login.
//
// Auth: v0.1 trusts whoever's on the dev box. v0.2+ should require a
// real user via the same getCurrentUser pattern as ledger-core.

import { plaidConnector } from "@/lib/connectors/plaid/connector";

export interface CreateLinkTokenState {
  ok: boolean;
  linkToken?: string;
  message?: string;
}

export async function createLinkTokenAction(): Promise<CreateLinkTokenState> {
  try {
    // The user id passed to Plaid is for THEIR rate limiting + audit;
    // doesn't have to match our system's user id. In dev we just pass
    // a constant. In production this becomes session.user.id.
    const result = await plaidConnector.initiateAuth({
      redirectUri: "", // Plaid Link is embedded, not redirect-based
      actorUserId: "integrations-dev-user",
    });
    if (!result.linkToken) {
      return { ok: false, message: "Plaid connector returned no link token" };
    }
    return { ok: true, linkToken: result.linkToken };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error minting link token",
    };
  }
}
