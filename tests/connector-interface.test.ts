// Connector interface conformance tests. Type-level + structural —
// makes sure each registered connector implements the contract.
//
// These are deliberately light because the interface is enforced by
// the TypeScript compiler — if the connector doesn't satisfy
// Connector<T>, tsc fails before vitest runs. What we test here is the
// runtime metadata (meta block, capability flags) since those are
// data, not types.

import { describe, it, expect } from "vitest";
import { plaidConnector } from "../src/lib/connectors/plaid/connector";

describe("plaidConnector: ConnectorMeta", () => {
  it("declares systemCode 'plaid'", () => {
    expect(plaidConnector.meta.systemCode).toBe("plaid");
  });

  it("declares targetType BANK_ACCOUNT (v0.1)", () => {
    expect(plaidConnector.meta.targetType).toBe("BANK_ACCOUNT");
  });

  it("declares correct capabilities for v0.1", () => {
    // Polling is the v0.1 sync model.
    expect(plaidConnector.meta.capabilities.polling).toBe(true);
    // Webhooks land in v0.2.
    expect(plaidConnector.meta.capabilities.webhook).toBe(false);
    // Plaid is read-only; no push support.
    expect(plaidConnector.meta.capabilities.push).toBe(false);
  });

  it("has a non-empty displayName", () => {
    expect(plaidConnector.meta.displayName.length).toBeGreaterThan(0);
  });
});

describe("plaidConnector: required methods present", () => {
  it("implements initiateAuth", () => {
    expect(typeof plaidConnector.initiateAuth).toBe("function");
  });

  it("implements completeAuth", () => {
    expect(typeof plaidConnector.completeAuth).toBe("function");
  });

  it("implements fetchSince (capability.polling=true requires it)", () => {
    expect(typeof plaidConnector.fetchSince).toBe("function");
  });
});

describe("plaidConnector: optional methods correctly absent (v0.1)", () => {
  it("does NOT implement pushRecord (push=false)", () => {
    expect(plaidConnector.pushRecord).toBeUndefined();
  });

  it("does NOT implement verifyWebhookSignature (webhook=false)", () => {
    expect(plaidConnector.verifyWebhookSignature).toBeUndefined();
  });

  it("does NOT implement parseWebhookEvent (webhook=false)", () => {
    expect(plaidConnector.parseWebhookEvent).toBeUndefined();
  });
});
