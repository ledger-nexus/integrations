// Bridge wire-shape tests. Mocked fetch — exercises the request
// body + response parsing without hitting recon.
//
// Covers v1.2 additions (Phase 2 of the Plaid modified+removed fix):
//   - modifiedLines + removedExternalIds appear in the request body
//     only when non-empty
//   - PromoteResult exposes linesModified, linesRemoved, and
//     approvedMatchesAffected from the recon response
//   - Modify/remove-only call still hits the endpoint (no early
//     "<empty>" return)

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  promoteToBankStatement,
  setFetchForTesting,
} from "../src/lib/recon-bridge";
import type { MappedBankLine } from "../src/lib/connectors/plaid/mapper";

function makeLine(over: Partial<MappedBankLine> = {}): MappedBankLine {
  return {
    externalId: over.externalId ?? "plaid-tx-1",
    transactionDate: over.transactionDate ?? new Date("2026-05-15"),
    description: over.description ?? "TEST MERCHANT",
    amount: over.amount ?? new Decimal("25.00"),
    pending: over.pending ?? false,
    currencyCode: over.currencyCode ?? "USD",
    mapperVersion: over.mapperVersion ?? "plaid/v1",
  };
}

interface CapturedRequest {
  body: Record<string, unknown>;
}

function makeMockFetch(
  response: unknown,
  capture: { last?: CapturedRequest } = {}
): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capture.last = {
      body: JSON.parse((init?.body as string) ?? "{}"),
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  setFetchForTesting(null);
  process.env.RECON_INTERNAL_API_TOKEN = "test-token";
  process.env.RECON_URL = "http://recon-test.local";
});

describe("recon-bridge — request body shape", () => {
  it("sends ADDED lines only when no modified/removed are present", async () => {
    const capture: { last?: CapturedRequest } = {};
    setFetchForTesting(
      makeMockFetch(
        {
          ok: true,
          bankStatementId: "stmt-1",
          linesCreated: 1,
          linesSkipped: 0,
          wasEmpty: false,
        },
        capture
      )
    );
    await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [makeLine()],
      syncRunId: "run-1",
    });
    expect(capture.last?.body.lines).toBeDefined();
    // Optional fields omitted from the body to keep the payload tight
    expect(capture.last?.body.modifiedLines).toBeUndefined();
    expect(capture.last?.body.removedExternalIds).toBeUndefined();
  });

  it("includes modifiedLines in the body when present", async () => {
    const capture: { last?: CapturedRequest } = {};
    setFetchForTesting(
      makeMockFetch(
        {
          ok: true,
          bankStatementId: null,
          linesCreated: 0,
          linesSkipped: 0,
          linesModified: 1,
          linesRemoved: 0,
          matchesWithdrawn: 0,
          approvedMatchesAffected: [],
          wasEmpty: false,
        },
        capture
      )
    );
    await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [],
      modifiedLines: [
        makeLine({ externalId: "plaid-tx-fix", amount: new Decimal("99.99") }),
      ],
      syncRunId: "run-2",
    });
    expect(capture.last?.body.modifiedLines).toEqual([
      expect.objectContaining({
        externalId: "plaid-tx-fix",
        amount: "99.99",
      }),
    ]);
  });

  it("includes removedExternalIds in the body when present", async () => {
    const capture: { last?: CapturedRequest } = {};
    setFetchForTesting(
      makeMockFetch(
        {
          ok: true,
          bankStatementId: null,
          linesCreated: 0,
          linesSkipped: 0,
          linesModified: 0,
          linesRemoved: 2,
          matchesWithdrawn: 1,
          approvedMatchesAffected: [],
          wasEmpty: false,
        },
        capture
      )
    );
    await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [],
      removedExternalIds: ["plaid-tx-gone-1", "plaid-tx-gone-2"],
      syncRunId: "run-3",
    });
    expect(capture.last?.body.removedExternalIds).toEqual([
      "plaid-tx-gone-1",
      "plaid-tx-gone-2",
    ]);
  });

  it("modify/remove-only sync still hits the endpoint", async () => {
    let fetched = false;
    setFetchForTesting(
      makeMockFetch(
        {
          ok: true,
          bankStatementId: null,
          linesCreated: 0,
          linesSkipped: 0,
          linesModified: 1,
          linesRemoved: 1,
          matchesWithdrawn: 0,
          approvedMatchesAffected: [],
          wasEmpty: false,
        }
      ).bind(null)
    );
    // Override again to capture invocation
    setFetchForTesting((async (input, init) => {
      fetched = true;
      return new Response(
        JSON.stringify({
          ok: true,
          bankStatementId: null,
          linesCreated: 0,
          linesSkipped: 0,
          linesModified: 1,
          linesRemoved: 1,
          matchesWithdrawn: 0,
          approvedMatchesAffected: [],
          wasEmpty: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch);
    const result = await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [],
      modifiedLines: [makeLine({ externalId: "fix-1" })],
      removedExternalIds: ["gone-1"],
      syncRunId: "run-4",
    });
    expect(fetched).toBe(true);
    expect(result.linesModified).toBe(1);
    expect(result.linesRemoved).toBe(1);
  });

  it("fully empty (no added/modified/removed) short-circuits without hitting the endpoint", async () => {
    let fetched = false;
    setFetchForTesting((async () => {
      fetched = true;
      return new Response("{}");
    }) as typeof fetch);
    const result = await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [],
      modifiedLines: [],
      removedExternalIds: [],
      syncRunId: "run-empty",
    });
    expect(fetched).toBe(false);
    expect(result.bankStatementId).toBe("<empty>");
    expect(result.lineCount).toBe(0);
    expect(result.linesModified).toBe(0);
    expect(result.linesRemoved).toBe(0);
  });
});

describe("recon-bridge — response parsing", () => {
  it("exposes linesModified + linesRemoved + approvedMatchesAffected", async () => {
    setFetchForTesting(
      makeMockFetch({
        ok: true,
        bankStatementId: "stmt-2",
        linesCreated: 0,
        linesSkipped: 0,
        linesModified: 3,
        linesRemoved: 2,
        matchesWithdrawn: 1,
        approvedMatchesAffected: [
          {
            externalId: "plaid-tx-A",
            bankLineId: "line-A",
            matchId: "match-A",
          },
        ],
        wasEmpty: false,
      })
    );
    const result = await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [makeLine()],
      syncRunId: "run-resp",
    });
    expect(result.linesModified).toBe(3);
    expect(result.linesRemoved).toBe(2);
    expect(result.approvedMatchesAffected).toHaveLength(1);
    expect(result.approvedMatchesAffected[0].externalId).toBe("plaid-tx-A");
  });

  it("defaults missing v1.2 fields to 0 / [] for back-compat with old recon deployments", async () => {
    // Simulate an older recon that doesn't return the new fields.
    setFetchForTesting(
      makeMockFetch({
        ok: true,
        bankStatementId: "stmt-3",
        linesCreated: 1,
        linesSkipped: 0,
        wasEmpty: false,
      })
    );
    const result = await promoteToBankStatement({
      bankAccountId: "acct-1",
      lines: [makeLine()],
      syncRunId: "run-legacy",
    });
    expect(result.linesModified).toBe(0);
    expect(result.linesRemoved).toBe(0);
    expect(result.approvedMatchesAffected).toEqual([]);
  });
});
