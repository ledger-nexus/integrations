// Test for the DSR connections-export stub.
// See recon/tests/recon-attribution-stub.test.ts for rationale.
//
// EXTRA INVARIANT for integrations: the interface MUST NOT have a
// credentials/tokens field. The auditor sees this test as enforcement
// of the Art. 15(4) rights-of-others carve-out.

import { describe, it, expect } from "vitest";
import {
  connectionsAttribution,
  NotImplementedError,
  type ConnectionsAttribution,
} from "../src/lib/privacy/connections-export";

describe("DSR — integrations connections-export stub (Privacy TSC contract)", () => {
  it("exports the connectionsAttribution function", () => {
    expect(typeof connectionsAttribution).toBe("function");
  });

  it("exports the NotImplementedError class", () => {
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("throws NotImplementedError when called (locks the contract)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    await expect(
      connectionsAttribution(fakePrisma, "test-user-id")
    ).rejects.toThrow(NotImplementedError);
  });

  it("error message points at the DSR doc's Open items section", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakePrisma = {} as any;
    try {
      await connectionsAttribution(fakePrisma, "test-user-id");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/data-subject-requests/);
      expect((e as Error).message).toMatch(/Open items/);
    }
  });

  it("ConnectionsAttribution interface has no credentials/tokens field (Art. 15(4) carve-out enforcement)", () => {
    // This is the LOAD-BEARING test for the integrations DSR stub.
    // If a future contributor adds a tokens/credentials/accessToken
    // field to the interface, this test fails at tsc.
    const shape: ConnectionsAttribution = {
      connectionsCreated: 0,
      connectionsByStatus: {} as ConnectionsAttribution["connectionsByStatus"],
      syncRunsInitiated: 0,
      connectionsBySystem: {},
      snapshotAt: "2026-06-03T00:00:00.000Z",
    };

    // Sanity: the keys we DO have don't contain credential-shaped names.
    const keys = Object.keys(shape);
    const forbidden = ["credentials", "tokens", "accessToken", "refreshToken"];
    for (const k of keys) {
      for (const f of forbidden) {
        expect(k.toLowerCase()).not.toContain(f.toLowerCase());
      }
    }
  });
});
