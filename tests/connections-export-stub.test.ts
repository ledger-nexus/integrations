// Contract tests for the DSR connections-export helper.
//
// These tests lock the INTERFACE shape — the "no credentials" invariant
// is the load-bearing one for the Art. 15(4) rights-of-others carve-
// out. Runtime-behavior tests (counts vs. real Postgres) live in
// `connections-export.test.ts`.
//
// Before v0.2: function threw NotImplementedError. After v0.2: the
// function is wired but the contract shape is still enforced here.

import { describe, it, expect } from "vitest";
import {
  connectionsAttribution,
  NotImplementedError,
  type ConnectionsAttribution,
} from "../src/lib/privacy/connections-export";

describe("DSR — integrations connections-export contract (Privacy TSC)", () => {
  it("exports the connectionsAttribution function", () => {
    expect(typeof connectionsAttribution).toBe("function");
  });

  it("retains the NotImplementedError class export (back-compat)", () => {
    // Kept for callers that imported it during the typed-stub era.
    expect(typeof NotImplementedError).toBe("function");
    expect(new NotImplementedError("test").name).toBe("NotImplementedError");
  });

  it("ConnectionsAttribution interface has no credentials/tokens field (Art. 15(4) carve-out enforcement)", () => {
    // This is the LOAD-BEARING test for the integrations DSR helper.
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
