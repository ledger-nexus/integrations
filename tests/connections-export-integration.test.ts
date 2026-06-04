// Integration tests for connectionsAttribution against real Postgres.
//
// Why real DB: the function uses Prisma `groupBy` and a relation-
// filtered `count`. Mocking these correctly is the same complexity
// as running them; running them surfaces actual SQL bugs (wrong
// column, missing index, enum mismatch).
//
// Cleanup: every row created here uses a per-test-suite userId
// (uuid-shaped sentinel beginning with DSR-TEST-). The `afterAll`
// hook deletes by createdBy match. Other tests' data is unaffected.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, ConnectionStatus } from "@prisma/client";

const prisma = new PrismaClient();

// Sentinel uuid for the test subject. Stable across runs so cleanup
// works even if a prior run crashed.
const TEST_SUBJECT_ID = "11111111-aaaa-bbbb-cccc-dddddddd0001";
// Sentinel for a different user; used to prove cross-user isolation.
const OTHER_SUBJECT_ID = "22222222-aaaa-bbbb-cccc-dddddddd0002";

async function cleanup() {
  // SyncRuns cascade-delete with Connection; just nuke connections.
  await prisma.connection.deleteMany({
    where: { createdBy: { in: [TEST_SUBJECT_ID, OTHER_SUBJECT_ID] } },
  });
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("connectionsAttribution — integration vs real Postgres", () => {
  it("returns empty-but-valid shape for a user with no connections", async () => {
    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );
    const result = await connectionsAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.connectionsCreated).toBe(0);
    expect(result.syncRunsInitiated).toBe(0);
    expect(result.connectionsBySystem).toEqual({});
    // Every status key present, all zero — shape stability.
    expect(result.connectionsByStatus).toEqual({
      ACTIVE: 0,
      PAUSED: 0,
      REVOKED: 0,
      ERROR: 0,
    });
    expect(result.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts connections created by the subject", async () => {
    await prisma.connection.create({
      data: {
        systemCode: "plaid",
        displayName: "Test Chase ****1234",
        status: ConnectionStatus.ACTIVE,
        targetType: "BANK_ACCOUNT",
        credentialsJson: { accessToken: "should-not-leak" },
        createdBy: TEST_SUBJECT_ID,
      },
    });
    await prisma.connection.create({
      data: {
        systemCode: "plaid",
        displayName: "Test BofA ****5678",
        status: ConnectionStatus.REVOKED,
        targetType: "BANK_ACCOUNT",
        credentialsJson: { accessToken: "also-should-not-leak" },
        createdBy: TEST_SUBJECT_ID,
      },
    });

    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );
    const result = await connectionsAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.connectionsCreated).toBe(2);
    expect(result.connectionsByStatus.ACTIVE).toBe(1);
    expect(result.connectionsByStatus.REVOKED).toBe(1);
    expect(result.connectionsByStatus.PAUSED).toBe(0);
    expect(result.connectionsByStatus.ERROR).toBe(0);
    expect(result.connectionsBySystem).toEqual({ plaid: 2 });
  });

  it("groups by systemCode across multiple upstreams", async () => {
    await prisma.connection.create({
      data: {
        systemCode: "stripe",
        displayName: "Test Stripe acct",
        status: ConnectionStatus.ACTIVE,
        targetType: "BANK_ACCOUNT",
        credentialsJson: { key: "redacted" },
        createdBy: TEST_SUBJECT_ID,
      },
    });

    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );
    const result = await connectionsAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.connectionsBySystem).toEqual({ plaid: 2, stripe: 1 });
    expect(result.connectionsCreated).toBe(3);
  });

  it("counts sync runs only for the subject's connections (relation-filtered)", async () => {
    const subjectConn = await prisma.connection.findFirst({
      where: { createdBy: TEST_SUBJECT_ID, systemCode: "plaid" },
    });
    expect(subjectConn).not.toBeNull();

    // Two SUCCESSes + one FAILURE = 3 runs for the subject.
    await prisma.syncRun.createMany({
      data: [
        {
          connectionId: subjectConn!.id,
          triggerType: "MANUAL",
          status: "SUCCESS",
          completedAt: new Date(),
        },
        {
          connectionId: subjectConn!.id,
          triggerType: "SCHEDULED",
          status: "SUCCESS",
          completedAt: new Date(),
        },
        {
          connectionId: subjectConn!.id,
          triggerType: "MANUAL",
          status: "FAILURE",
          completedAt: new Date(),
        },
      ],
    });

    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );
    const result = await connectionsAttribution(prisma, TEST_SUBJECT_ID);

    expect(result.syncRunsInitiated).toBe(3);
  });

  it("does not leak the other user's connections (cross-subject isolation)", async () => {
    // Create connections owned by OTHER_SUBJECT_ID — these must NOT
    // appear in TEST_SUBJECT_ID's attribution.
    const otherConn = await prisma.connection.create({
      data: {
        systemCode: "gusto",
        displayName: "Other user Gusto",
        status: ConnectionStatus.ACTIVE,
        targetType: "BANK_ACCOUNT",
        credentialsJson: { key: "redacted" },
        createdBy: OTHER_SUBJECT_ID,
      },
    });
    await prisma.syncRun.create({
      data: {
        connectionId: otherConn.id,
        triggerType: "MANUAL",
        status: "SUCCESS",
        completedAt: new Date(),
      },
    });

    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );

    const testResult = await connectionsAttribution(prisma, TEST_SUBJECT_ID);
    const otherResult = await connectionsAttribution(prisma, OTHER_SUBJECT_ID);

    // TEST_SUBJECT counts unchanged from previous assertions.
    expect(testResult.connectionsCreated).toBe(3);
    expect(testResult.connectionsBySystem.gusto).toBeUndefined();
    expect(testResult.syncRunsInitiated).toBe(3);

    // OTHER_SUBJECT sees only its own row.
    expect(otherResult.connectionsCreated).toBe(1);
    expect(otherResult.connectionsBySystem).toEqual({ gusto: 1 });
    expect(otherResult.syncRunsInitiated).toBe(1);
  });

  it("HARD INVARIANT: returned object contains no credentials-shaped values", async () => {
    // Even though the interface forbids it at compile time, the runtime
    // contract bears defense-in-depth: the JSON-serialized result must
    // not contain any token-shaped string from credentialsJson.
    const { connectionsAttribution } = await import(
      "../src/lib/privacy/connections-export"
    );
    const result = await connectionsAttribution(prisma, TEST_SUBJECT_ID);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("also-should-not-leak");
    expect(serialized.toLowerCase()).not.toContain("accesstoken");
    expect(serialized.toLowerCase()).not.toContain("refreshtoken");
    expect(serialized.toLowerCase()).not.toContain("credentials");
  });
});
