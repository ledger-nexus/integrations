// Plaid webhook parser tests. Pure function, no DB / HTTP needed.
//
// The substantive guarantee: which webhook codes signal "needs
// immediate fetch" (sync trigger) vs "ignored / handled elsewhere".

import { describe, it, expect } from "vitest";
import { plaidConnector } from "../src/lib/connectors/plaid/connector";

const parse = plaidConnector.parseWebhookEvent!;

describe("plaidConnector.parseWebhookEvent — sync triggers", () => {
  it("SYNC_UPDATES_AVAILABLE (modern /transactions/sync) triggers fetch", async () => {
    const r = await parse({
      body: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(true);
    expect(r.records).toEqual([]);
  });

  it("DEFAULT_UPDATE (legacy /transactions/get) triggers fetch", async () => {
    const r = await parse({
      body: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "DEFAULT_UPDATE",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(true);
  });

  it("INITIAL_UPDATE (first-time sync ready) triggers fetch", async () => {
    const r = await parse({
      body: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "INITIAL_UPDATE",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(true);
  });

  it("HISTORICAL_UPDATE (24mo backfill ready) triggers fetch", async () => {
    const r = await parse({
      body: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "HISTORICAL_UPDATE",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(true);
  });

  it("TRANSACTIONS_REMOVED triggers fetch (next sync returns removed records)", async () => {
    const r = await parse({
      body: {
        webhook_type: "TRANSACTIONS",
        webhook_code: "TRANSACTIONS_REMOVED",
        item_id: "item-1",
        removed_transactions: ["tx-1", "tx-2"],
      },
    });
    expect(r.needsImmediateFetch).toBe(true);
  });
});

describe("plaidConnector.parseWebhookEvent — no-op codes", () => {
  it("ITEM / ERROR does NOT trigger a sync (route handler updates Connection.status separately)", async () => {
    const r = await parse({
      body: {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "item-1",
        error: { error_type: "ITEM_LOGIN_REQUIRED" },
      },
    });
    expect(r.needsImmediateFetch).toBe(false);
    expect(r.records).toEqual([]);
  });

  it("ITEM / WEBHOOK_UPDATE_ACKNOWLEDGED doesn't trigger a sync", async () => {
    const r = await parse({
      body: {
        webhook_type: "ITEM",
        webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(false);
  });

  it("Unknown webhook_type doesn't trigger a sync", async () => {
    const r = await parse({
      body: {
        webhook_type: "FUTURE_NEW_TYPE",
        webhook_code: "SOMETHING",
        item_id: "item-1",
      },
    });
    expect(r.needsImmediateFetch).toBe(false);
  });
});

describe("plaidConnector.parseWebhookEvent — malformed input", () => {
  it("Null body returns empty + no-fetch (defensive)", async () => {
    const r = await parse({ body: null });
    expect(r.needsImmediateFetch).toBe(false);
    expect(r.records).toEqual([]);
  });

  it("Non-object body returns empty + no-fetch", async () => {
    const r = await parse({ body: "not an object" as unknown });
    expect(r.needsImmediateFetch).toBe(false);
  });

  it("Missing webhook_type doesn't trigger", async () => {
    const r = await parse({ body: { webhook_code: "SYNC_UPDATES_AVAILABLE" } });
    expect(r.needsImmediateFetch).toBe(false);
  });

  it("Wrong webhook_type for a TRANSACTIONS code doesn't trigger", async () => {
    const r = await parse({
      body: {
        webhook_type: "ITEM", // wrong — SYNC_UPDATES_AVAILABLE is TRANSACTIONS
        webhook_code: "SYNC_UPDATES_AVAILABLE",
      },
    });
    expect(r.needsImmediateFetch).toBe(false);
  });
});
