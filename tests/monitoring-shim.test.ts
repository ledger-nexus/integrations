// Unit tests for the integrations monitoring shim.
//
// Mirror of fa-amort PR #21 + recon PR #24 + revenue-rec PR #28 with
// integrations-specific PII fields (credentialsJson, accessToken,
// publicToken, rawRecord) — the load-bearing carve-out per
// data-classification.md (OAuth token leak = Critical incident).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  redactPii,
  PII_FIELDS,
  stripStackPreamble,
  sanitizeErrorForCapture,
} from "../src/lib/soc2/redact-pii";
import {
  captureError,
  captureMessage,
} from "../src/lib/monitoring";

describe("redactPii — PII allowlist", () => {
  it("redacts every field in the canonical PII set", () => {
    const obj = {
      email: "alice@example.com",
      password: "hunter2",
      token: "tok_abc",
      apiKey: "key_xyz",
      accessToken: "plk-access-secret",
      refreshToken: "plk-refresh-secret",
      publicToken: "plk-public-exchange",
      credentialsJson: { type: "plaid", accessToken: "leaked-if-not-redacted" },
      rawRecord: { transactions: [{ amount: 100 }] },
      rawPayload: { from_bank_api: "sensitive" },
      accountNumber: "1234567890",
      bankName: "Acme Bank",
      description: "CHECK 123 PAID TO JANE DOE",
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.email).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.refreshToken).toBe("[REDACTED]");
    expect(out.publicToken).toBe("[REDACTED]");
    expect(out.credentialsJson).toBe("[REDACTED]");
    expect(out.rawRecord).toBe("[REDACTED]");
    expect(out.rawPayload).toBe("[REDACTED]");
    expect(out.accountNumber).toBe("[REDACTED]");
    expect(out.bankName).toBe("[REDACTED]");
    expect(out.description).toBe("[REDACTED]");
    expect(out.benign).toBe("value");
  });

  it("does NOT mutate the input object", () => {
    const obj = { email: "x@y.com", benign: 1 };
    const out = redactPii(obj);
    expect(obj.email).toBe("x@y.com");
    expect(out.email).toBe("[REDACTED]");
  });

  it("traverses arrays of objects", () => {
    const arr = [
      { accessToken: "secret-1" },
      { accessToken: "secret-2" },
    ];
    const out = redactPii(arr);
    expect(out[0].accessToken).toBe("[REDACTED]");
    expect(out[1].accessToken).toBe("[REDACTED]");
  });

  it("redacts nested credentialsJson deep inside an object tree", () => {
    const obj = {
      connection: {
        meta: {
          credentialsJson: { accessToken: "buried-token" },
          other: "ok",
        },
      },
    };
    const out = redactPii(obj);
    expect(out.connection.meta.credentialsJson).toBe("[REDACTED]");
    expect(out.connection.meta.other).toBe("ok");
  });

  it("preserves null + undefined + primitives", () => {
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
    expect(redactPii("hello")).toBe("hello");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
  });

  it("redacts Error.message but keeps name + stack", () => {
    const err = new Error("Sync failed for token plk-secret-abc");
    const out = redactPii(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("[REDACTED]");
    expect(out.stack).toBeTruthy();
  });

  it("exports PII_FIELDS for audit trail (load-bearing fields present)", () => {
    expect(PII_FIELDS).toBeInstanceOf(Set);
    expect(PII_FIELDS.has("email")).toBe(true);
    expect(PII_FIELDS.has("credentialsJson")).toBe(true); // Critical
    expect(PII_FIELDS.has("accessToken")).toBe(true); // Critical
    expect(PII_FIELDS.has("publicToken")).toBe(true);
    expect(PII_FIELDS.has("rawRecord")).toBe(true);
    // 14th-pass M4: vendor-prefixed identifier gap-fills.
    expect(PII_FIELDS.has("plaidItemId")).toBe(true);
    expect(PII_FIELDS.has("stripeCustomerId")).toBe(true);
    expect(PII_FIELDS.has("gustoEmployeeId")).toBe(true);
    expect(PII_FIELDS.has("linkToken")).toBe(true);
    expect(PII_FIELDS.has("benign")).toBe(false);
  });

  it("14th-pass H1: strips OAuth token from Error.stack preamble (Critical)", () => {
    const err = new Error("Sync failed for token plk-secret-abcdef-12345");
    const out = redactPii(err);
    expect(out.stack).not.toContain("plk-secret-abcdef-12345");
    expect(out.stack).toContain("    at ");
    expect(out.stack).toContain("[REDACTED]");
  });

  it("14th-pass H1: stripStackPreamble handles edges", () => {
    expect(stripStackPreamble(undefined)).toBe(undefined);
    expect(stripStackPreamble("custom format")).toBe("custom format");
  });

  it("14th-pass M4: redacts vendor-prefixed identifiers", () => {
    const obj = {
      plaidItemId: "item-abc123",
      stripeCustomerId: "cus_def456",
      gustoEmployeeId: "emp-ghi789",
      linkToken: "link-secret-xyz",
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.plaidItemId).toBe("[REDACTED]");
    expect(out.stripeCustomerId).toBe("[REDACTED]");
    expect(out.gustoEmployeeId).toBe("[REDACTED]");
    expect(out.linkToken).toBe("[REDACTED]");
    expect(out.benign).toBe("value");
  });
});

describe("captureError — Sentry fallback path", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleErrorSpy.mockRestore();
  });

  it("calls console.error with [monitoring] prefix when DSN absent", () => {
    captureError(new Error("boom"), { context: "test" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe("[monitoring]");
  });

  it("does NOT pass raw err.message to console (OAuth token leak prevention — load-bearing)", () => {
    const err = new Error("Plaid sync failed for token plk-secret-abcdef-12345");
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("plk-secret-abcdef-12345");
    expect(serialized).not.toContain("Plaid sync failed for token");
    expect(serialized).toContain("errName");
  });

  it("redacts credentialsJson from the extra context (Critical leak prevention)", () => {
    captureError(new Error("x"), {
      context: "test",
      extra: {
        credentialsJson: { accessToken: "plk-secret-token" },
        connectionId: "conn-abc",
      },
    });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("plk-secret-token");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("conn-abc"); // non-PII passes through
  });

  it("passes through non-Error primitives as errPrimitive", () => {
    captureError("string-error", { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).toContain("errPrimitive");
    expect(serialized).toContain("string-error");
  });

  it("14th-pass M1: caps err.code at 16 chars", () => {
    const err = new Error("boom");
    (err as { code?: string }).code =
      "ECONNREFUSED: 10.0.1.42:5432 server-side";
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("10.0.1.42");
    expect(serialized).toContain("ECONNREFUSED: 10");
  });
});

describe("sanitizeErrorForCapture — Sentry path safety (14th-pass H1)", () => {
  it("returns non-Errors unchanged", () => {
    expect(sanitizeErrorForCapture("string-error")).toBe("string-error");
  });

  it("returns a NEW Error (doesn't mutate the caller's err)", () => {
    const original = new Error("Failed for token plk-secret");
    const out = sanitizeErrorForCapture(original);
    expect(original.message).toBe("Failed for token plk-secret");
    expect((out as Error).message).toBe("[REDACTED]");
  });

  it("strips OAuth token from the returned Error's .stack (Critical)", () => {
    const original = new Error("Failed for token plk-secret-abcdef-12345");
    const out = sanitizeErrorForCapture(original) as Error;
    expect(out.stack).not.toContain("plk-secret-abcdef-12345");
    expect(out.stack).toContain("[REDACTED]");
  });
});

describe("captureMessage — level routing", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("info → console.log", () => {
    captureMessage("informational", "info");
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("warning → console.warn", () => {
    captureMessage("warn", "warning");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("error → console.error", () => {
    captureMessage("err", "error");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
