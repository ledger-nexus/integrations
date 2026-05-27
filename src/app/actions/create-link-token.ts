"use server";

// Server Action that mints a Plaid Link token. Called from the Connect
// page's <PlaidLinkButton /> client component — Plaid Link opens
// directly with this token; no further server round trip needed until
// the user finishes the bank login.
//
// SECURITY (pen-test pass 4): requires a signed-in user. Without the
// auth gate, an attacker could mint unlimited Plaid Link tokens —
// burning the Plaid quota and creating a billable-event DoS. The
// minted user id passed to Plaid is now the real authenticated user
// (was a hardcoded "integrations-dev-user").

import { plaidConnector } from "@/lib/connectors/plaid/connector";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/session";

export interface CreateLinkTokenState {
  ok: boolean;
  linkToken?: string;
  message?: string;
}

export async function createLinkTokenAction(): Promise<CreateLinkTokenState> {
  try {
    const user = await requireCurrentUser();

    const result = await plaidConnector.initiateAuth({
      redirectUri: "", // Plaid Link is embedded, not redirect-based
      actorUserId: user.id,
    });
    if (!result.linkToken) {
      return { ok: false, message: "Plaid connector returned no link token" };
    }
    return { ok: true, linkToken: result.linkToken };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in to connect a bank account." };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error minting link token",
    };
  }
}
