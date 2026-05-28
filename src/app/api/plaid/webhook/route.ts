// POST /api/plaid/webhook
//
// Inbound Plaid webhook receiver. Plaid POSTs here when one of the
// events we subscribed to fires for an item in our system — most
// commonly TRANSACTIONS / SYNC_UPDATES_AVAILABLE, signaling "new
// transactions are ready for this item, call /transactions/sync".
//
// What this route does:
//
//   1. Verify the request is from Plaid. v1 uses a URL-token shared
//      secret (PLAID_WEBHOOK_SECRET env). The path is configured in
//      the Plaid dashboard as
//        https://<your-domain>/api/plaid/webhook?token=<secret>
//      Requests missing or mismatching the token are 401'd.
//
//      v2 will add Plaid's proper JWT verification (ES256 signature
//      over the request body, key fetched from
//      /webhook_verification_key/get). The URL-token approach is
//      acceptable for v1 because the secret is held only in Plaid's
//      dashboard + this env; an attacker would need both the URL and
//      the secret to spoof.
//
//   2. Persist a PlaidWebhookEvent row regardless of outcome. Operator
//      can debug "did Plaid actually send us X?" without external
//      logs.
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ─── 1. Auth ──────────────────────────────────────────────────────────
  const secret = process.env.PLAID_WEBHOOK_SECRET;
  const url = new URL(req.url);
  const provided = url.searchParams.get("token") ?? "";

  if (!secret) {
    // Production must have the secret set. Dev / staging without can
    // pass through for local tunnel testing (the webhook URL is only
    // known to Plaid + your dev tunnel, so the surface is naturally
    // limited).
    if (isProd()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "PLAID_WEBHOOK_SECRET env var is not set; endpoint disabled in production.",
        },
        { status: 503 }
      );
    }
    // Dev pass-through.
  } else if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or missing webhook token" },
      { status: 401 }
    );
  }

  // ─── 2. Parse payload ─────────────────────────────────────────────────
  let body: PlaidPayload;
  try {
    body = (await req.json()) as PlaidPayload;
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
  });
}
