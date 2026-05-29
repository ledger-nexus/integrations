// Plaid connector — modified + removed transaction handling.
//
// Banks correct charge amounts (gas pump pre-auth → actual fillup) and
// cancel transactions (declined post-auth). Plaid's /transactions/sync
// surfaces these as `modified` and `removed` on the response. The
// connector now emits them through FetchPage so the engine stages and
// counts them on SyncRun.
//
// Covers:
//   - added records go to FetchPage.records (existing behavior)
//   - modified records go to FetchPage.modifiedRecords
//   - removed transaction_ids go to FetchPage.removedExternalIds
//   - account filter applies to added + modified (not removed — Plaid
//     doesn't include account_id on removed records)
//   - empty arrays from Plaid produce empty arrays in FetchPage
//     (NOT undefined — consumer code is more uniform)
//   - multi-page sync threads all three through across pages

import { describe, it, expect } from "vitest";
import { plaidConnector } from "../src/lib/connectors/plaid/connector";
import { setPlaidClientForTesting } from "../src/lib/connectors/plaid/client";
import type { PlaidTransaction } from "../src/lib/connectors/plaid/types";

function makeTransaction(
  over: Partial<PlaidTransaction> & { transaction_id: string; account_id: string }
): PlaidTransaction {
  return {
    amount: 25.0,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-05-15",
    name: "Test merchant",
    pending: false,
    ...over,
  };
}

function makeMockClient(responses: Array<{
  added?: PlaidTransaction[];
  modified?: PlaidTransaction[];
  removed?: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}>): unknown {
  let callIndex = 0;
  return {
    transactionsSync: async () => {
      const r = responses[callIndex];
      callIndex += 1;
      return {
        data: {
          added: r.added ?? [],
          modified: r.modified ?? [],
          removed: r.removed ?? [],
          next_cursor: r.next_cursor,
          has_more: r.has_more,
        },
      };
    },
  };
}

describe("plaidConnector.fetchSince — added/modified/removed handling", () => {
  it("emits added records on FetchPage.records (existing behavior)", async () => {
    setPlaidClientForTesting(
      makeMockClient([
        {
          added: [
            makeTransaction({ transaction_id: "tx-1", account_id: "acct-A" }),
            makeTransaction({ transaction_id: "tx-2", account_id: "acct-A" }),
          ],
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(pages[0].records).toHaveLength(2);
    expect(pages[0].records[0].externalId).toBe("tx-1");
    expect(pages[0].modifiedRecords).toEqual([]);
    expect(pages[0].removedExternalIds).toEqual([]);
    expect(pages[0].nextCursor).toBeNull();
  });

  it("emits modified records on FetchPage.modifiedRecords", async () => {
    setPlaidClientForTesting(
      makeMockClient([
        {
          modified: [
            makeTransaction({
              transaction_id: "tx-3",
              account_id: "acct-A",
              amount: 99.99, // corrected from earlier
              name: "GAS PUMP fillup",
            }),
          ],
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages[0].records).toEqual([]);
    expect(pages[0].modifiedRecords).toHaveLength(1);
    expect(pages[0].modifiedRecords![0].externalId).toBe("tx-3");
    expect(pages[0].modifiedRecords![0].raw.amount).toBe(99.99);
  });

  it("emits removed transaction_ids on FetchPage.removedExternalIds", async () => {
    setPlaidClientForTesting(
      makeMockClient([
        {
          removed: [{ transaction_id: "tx-4" }, { transaction_id: "tx-5" }],
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages[0].records).toEqual([]);
    expect(pages[0].removedExternalIds).toEqual(["tx-4", "tx-5"]);
  });

  it("filters added + modified by accountId but lets all removed through", async () => {
    // Plaid's removed records carry only transaction_id (no
    // account_id). We can't filter; recon-side dedup catches any
    // externalIds that never belonged to this connection.
    setPlaidClientForTesting(
      makeMockClient([
        {
          added: [
            makeTransaction({ transaction_id: "tx-A1", account_id: "acct-A" }),
            makeTransaction({ transaction_id: "tx-B1", account_id: "acct-B" }), // filtered out
          ],
          modified: [
            makeTransaction({ transaction_id: "tx-A2", account_id: "acct-A" }),
            makeTransaction({ transaction_id: "tx-B2", account_id: "acct-B" }), // filtered out
          ],
          removed: [
            { transaction_id: "tx-A3" }, // no account info — let through
            { transaction_id: "tx-FOREIGN" }, // also let through
          ],
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages[0].records.map((r) => r.externalId)).toEqual(["tx-A1"]);
    expect(pages[0].modifiedRecords!.map((r) => r.externalId)).toEqual([
      "tx-A2",
    ]);
    expect(pages[0].removedExternalIds).toEqual(["tx-A3", "tx-FOREIGN"]);
  });

  it("includes all three across multiple pages", async () => {
    setPlaidClientForTesting(
      makeMockClient([
        {
          added: [makeTransaction({ transaction_id: "p1-a1", account_id: "acct-A" })],
          modified: [makeTransaction({ transaction_id: "p1-m1", account_id: "acct-A" })],
          removed: [{ transaction_id: "p1-r1" }],
          next_cursor: "cursor-page-2",
          has_more: true,
        },
        {
          added: [makeTransaction({ transaction_id: "p2-a1", account_id: "acct-A" })],
          modified: [],
          removed: [{ transaction_id: "p2-r1" }, { transaction_id: "p2-r2" }],
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages).toHaveLength(2);

    // Aggregate counts across pages — what the runner will see.
    const totalAdded = pages.reduce((acc, p) => acc + p.records.length, 0);
    const totalModified = pages.reduce(
      (acc, p) => acc + (p.modifiedRecords?.length ?? 0),
      0
    );
    const totalRemoved = pages.reduce(
      (acc, p) => acc + (p.removedExternalIds?.length ?? 0),
      0
    );
    expect(totalAdded).toBe(2);
    expect(totalModified).toBe(1);
    expect(totalRemoved).toBe(3);
  });

  it("emits empty arrays (not undefined) when Plaid returns nothing in a category", async () => {
    setPlaidClientForTesting(
      makeMockClient([
        {
          added: [makeTransaction({ transaction_id: "tx-1", account_id: "acct-A" })],
          // modified + removed deliberately omitted from this call's shape
          next_cursor: "cursor-end",
          has_more: false,
        },
      ]) as Parameters<typeof setPlaidClientForTesting>[0]
    );

    const pages = [];
    for await (const page of plaidConnector.fetchSince({
      credentials: { accessToken: "test", itemId: "item-1", accountId: "acct-A" },
      cursor: null,
    })) {
      pages.push(page);
    }
    expect(pages[0].modifiedRecords).toEqual([]);
    expect(pages[0].removedExternalIds).toEqual([]);
  });
});
