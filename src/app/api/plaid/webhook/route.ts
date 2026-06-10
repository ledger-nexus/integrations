// POST /api/plaid/webhook
//
// Inbound Plaid webhook receiver. Plaid POSTs here when one of the
// events we subscribed to fires for an item in our system — most
// commonly TRANSACTIONS / SYNC_UPDATES_AVAILABLE, signaling "new
// transactions are ready for this item, call /transactions/sync".
//
// What this route does:
//
//   1. Verify the request is from Plaid. Two auth ladders, JWT-first:
//
//      a. JWT verification (v2, the strong path). Plaid signs every
//         webhook with an ES256 JWT in the `Plaid-Verification` header.
//         We decode the JWT, fetch the corresponding JWK from Plaid
//         (cached in-process by kid), and verify:
//           - signature is valid for the kid's public key
//           - iat is within Plaid's 5-min replay window
//           - SHA-256 of the request body matches the signed claim
//
//      b. URL-token (v1, legacy belt-and-suspenders). If
//         PLAID_WEBHOOK_SECRET is set, the request must also match a
//         shared secret embedded in the URL:
//           https://<your-domain>/api/plaid/webhook?token=<secret>
//
//      Auth policy:
//        - Production: JWT verification is REQUIRED unless explicitly
//          disabled via PLAID_WEBHOOK_JWT_REQUIRED=false. If
//          PLAID_WEBHOOK_SECRET is also set, the URL-token must also
//          match (defense in depth).
//        - Dev/staging: JWT is optional. If the header is present, it
//          must verify cleanly. URL-token (if set) is also required.
//          With neither configured, dev pass-through is allowed for
//          local tunnel testing.
//
//   2. Persist a PlaidWebhookEvent row regardless of outcome. Operator
//      can debug "did Plaid actually send us X?" without external
//      logs. The audit row records how the request was authenticated
//      (verificationMethod = JWT / URL_TOKEN / DEV_OPEN) and which kid
//      signed it.
//
//   3. Match the payload's item_id to a Connection by walking
//      Connection.credentialsJson.itemId. (We can't query a JSON
//      column directly via Prisma's typed API; loading all active
//      Plaid connections and matching in code is fine — connection
//      count per tenant is small.)
//
//   4. Route based on webhook_type + webhook_code:
//        - TRANSACTIONS / SYNC_UPDATES_AVAILABLE (+ DEFAULT_UPDATE,
//          INITIAL_UPDATE, HISTORICAL_UPDATE, TRANSACTIONS_REMOVED):
//          trigger runConnectionSync with triggerType=WEBHOOK.
//        - ITEM / ERROR: mark Connection.status = ERROR. Operator
//          sees the error on /connections and can reauthorize.
//        - Anything else: log + ignore.
//
//   5. Always return 200 to Plaid (with a JSON body explaining the
//      outcome) UNLESS auth fails. Plaid retries non-2xx for 24h;
//      returning 200 + ignoring unknown event types prevents retry
//      storms when Plaid adds a new event type.
//
// Idempotency: webhooks are routinely re-delivered. The downstream
// /transactions/sync is itself idempotent via the cursor — a duplicate
// "new transactions available" produces zero new records on the
// second sync.
//
// Body handling: we read the raw text first (req.text()) and JSON.parse
// it ourselves. The JWT's request_body_sha256 claim is computed over
// the exact bytes Plaid sent — round-tripping through req.json() and
// re-stringifying would change whitespace + key order and break the
// hash.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { plaidConnector } from "@/lib/connectors/plaid/connector";
import { runConnectionSync } from "@/lib/sync/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlaidPayload {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  // Other fields vary by event type; we keep them as `unknown` and
  // persist the verbatim payload to PlaidWebhookEvent.rawPayload.
  [key: string]: unknown;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function jwtRequired(): boolean {
  // Default: required in production, optional in dev. Operator can
  // force either via env (e.g., to test JWT path locally, or to keep
  // legacy URL-token-only behavior during a staged rollout).
  const flag = process.env.PLAID_WEBHOOK_JWT_REQUIRED?.toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return isProd();
}

/**
 * Normalize Next's Headers iterable into a lowercased plain object so
 * the verifier (which expects `headers["plaid-verification"]`) is HTTP-
 * framework-agnostic.
 */
function headersToObject(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

interface AuthResult {
  ok: boolean;
  verificationMethod: "JWT" | "URL_TOKEN" | "DEV_OPEN";
  kid?: string;
  errorReason?: string;
}

async function authenticate(
  req: NextRequest,
  rawBody: string,
  headers: Record<string, string>
): Promise<AuthResult> {
  const urlSecret = process.env.PLAID_WEBHOOK_SECRET;
  const provided = new URL(req.url).searchParams.get("token") ?? "";
  const hasUrlSecret = !!urlSecret;
  const hasJwtHeader = !!headers["plaid-verification"];
  const requireJwt = jwtRequired();

  // ─── JWT path ────────────────────────────────────────────────────────────
  if (hasJwtHeader) {
    const result = await plaidConnector.verifyWebhookSignature!({
      rawBody,
      headers,
    });
    const verifyResult = await result;
    if (!verifyResult.ok) {
      // A header was present but bad. Always a fail — we never silently
      // downgrade from JWT to URL-token when the JWT is malformed,
      // because that would let an attacker bypass JWT by sending a
      // garbage JWT + a stolen URL-token.
      return {
        ok: false,
        verificationMethod: "JWT",
        errorReason: verifyResult.reason,
      };
    }
    // JWT verified. Also enforce URL-token if configured (belt-and-
    // suspenders — both gates must pass).
    if (hasUrlSecret && !constantTimeEquals(provided, urlSecret)) {
      return {
        ok: false,
        verificationMethod: "JWT",
        kid: verifyResult.kid,
        errorReason: "JWT verified but PLAID_WEBHOOK_SECRET URL-token mismatch",
      };
    }
    return { ok: true, verificationMethod: "JWT", kid: verifyResult.kid };
  }

  // ─── No JWT header ───────────────────────────────────────────────────────
  if (requireJwt) {
    return {
      ok: false,
      verificationMethod: "JWT",
      errorReason: "Missing Plaid-Verification header (JWT required)",
    };
  }
  if (hasUrlSecret) {
    if (!constantTimeEquals(provided, urlSecret)) {
      return {
        ok: false,
        verificationMethod: "URL_TOKEN",
        errorReason: "Invalid or missing webhook token",
      };
    }
    return { ok: true, verificationMethod: "URL_TOKEN" };
  }
  if (isProd()) {
    // Should never hit this: if we're in prod and JWT is not required
    // and there's no URL-token, something is misconfigured. Fail
    // closed.
    return {
      ok: false,
      verificationMethod: "DEV_OPEN",
      errorReason:
        "No auth configured in production (set PLAID_WEBHOOK_JWT_REQUIRED=true or PLAID_WEBHOOK_SECRET)",
    };
  }
  return { ok: true, verificationMethod: "DEV_OPEN" };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ─── 0. Read the raw body once — required for JWT hash check ─────────────
  // Re-stringifying req.json() output would change whitespace/key order
  // and break the request_body_sha256 verification.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Failed to read request body" },
      { status: 400 }
    );
  }
  const headers = headersToObject(req);

  // ─── 1. Auth ──────────────────────────────────────────────────────────
  const auth = await authenticate(req, rawBody, headers);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.errorReason ?? "Authentication failed" },
      { status: 401 }
    );
  }

  // ─── 2. Parse payload ─────────────────────────────────────────────────
  let body: PlaidPayload;
  try {
    body = JSON.parse(rawBody) as PlaidPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body is not valid JSON" },
      { status: 400 }
    );
  }
  const webhookType = body.webhook_type ?? "(missing)";
  const webhookCode = body.webhook_code ?? "(missing)";
  const plaidItemId = body.item_id ?? "(missing)";

  // ─── 3. Match to Connection by item_id ────────────────────────────────
  //
  // Plaid items are stored as Connection.credentialsJson.itemId. There's
  // no Prisma typed-query for JSON columns, but the active-Plaid-
  // connection count per deployment is small enough that loading them
  // in-memory + matching is fine. If this becomes a bottleneck, promote
  // itemId to a top-level column.
  const candidates = await prisma.connection.findMany({
    where: {
      systemCode: "plaid",
      deactivatedAt: null,
    },
    select: {
      id: true,
      credentialsJson: true,
      status: true,
    },
  });
  let connectionId: string | null = null;
  for (const c of candidates) {
    const creds = c.credentialsJson as { itemId?: string } | null;
    if (creds?.itemId === plaidItemId) {
      connectionId = c.id;
      break;
    }
  }

  // ─── 4. Decide outcome + parseWebhookEvent ────────────────────────────
  let outcome: string;
  let outcomeMessage: string | null = null;
  let triggeredSync = false;
  let syncRunId: string | null = null;

  if (!connectionId) {
    // No matching Connection — usually a stale webhook from a removed
    // item. Persist + 200 (Plaid stops retrying once it gets a 2xx).
    outcome = "IGNORED";
    outcomeMessage = `No active Plaid connection matched item_id=${plaidItemId}`;
  } else if (webhookType === "ITEM" && webhookCode === "ERROR") {
    // The user's bank-side authorization broke (e.g. they changed
    // their password). Mark the connection ERROR so the operator sees
    // it on /connections and can prompt the user to re-link.
    await prisma.connection.update({
      where: { id: connectionId },
      data: { status: "ERROR" },
    });
    outcome = "ITEM_ERROR_RECORDED";
    outcomeMessage = "Connection marked ERROR — re-link required";
  } else {
    // Anything else: ask the connector whether to trigger a sync.
    const parsed = await plaidConnector.parseWebhookEvent!({ body });
    if (parsed.needsImmediateFetch) {
      try {
        const result = await runConnectionSync({
          connectionId,
          triggerType: "WEBHOOK",
        });
        triggeredSync = true;
        syncRunId = result.syncRunId;
        outcome = "SYNC_TRIGGERED";
        outcomeMessage = `Status: ${result.status}; added ${result.recordsAdded}, promoted ${result.recordsPromoted}`;
      } catch (e) {
        outcome = "FAILED";
        outcomeMessage =
          e instanceof Error ? e.message : "Unknown error during sync";
      }
    } else {
      outcome = "IGNORED";
      outcomeMessage = `Webhook type=${webhookType} code=${webhookCode} doesn't trigger a sync`;
    }
  }

  // ─── 5. Audit row ─────────────────────────────────────────────────────
  // Wrapped in try/catch — a failed audit write shouldn't cause Plaid
  // to retry. Log + swallow.
  try {
    await prisma.plaidWebhookEvent.create({
      data: {
        connectionId,
        plaidItemId,
        webhookType,
        webhookCode,
        rawPayload: body as object,
        triggeredSync,
        syncRunId,
        outcome,
        outcomeMessage,
        verificationMethod: auth.verificationMethod,
        verificationKid: auth.kid ?? null,
      },
    });
  } catch (e) {
    console.error("[plaid-webhook] failed to persist audit row", e);
  }

  return NextResponse.json({
    ok: true,
    connectionId,
    outcome,
    outcomeMessage,
    syncRunId,
    verificationMethod: auth.verificationMethod,
  });
}
