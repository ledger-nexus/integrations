// Plaid mapper unit tests. Pure functions; no DB / network.
//
// Key invariant: the SIGN FLIP. Plaid signs amounts opposite to our
// convention. The mapper MUST invert. Tests exercise both directions
// (deposits and withdrawals) explicitly.

import { describe, it, expect } from "vitest";
import { plaidMapperV1 } from "../src/lib/connectors/plaid/mapper";
import type { PlaidTransaction } from "../src/lib/connectors/plaid/types";

function buildTxn(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: "txn-001",
    account_id: "acct-001",
    amount: 50.0,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-03-15",
    name: "Starbucks",
    pending: false,
    ...overrides,
  };
}

describe("plaidMapperV1: sign flip", () => {
  it("Plaid positive (outflow) → recon negative (withdrawal)", () => {
    const r = plaidMapperV1.map(buildTxn({ amount: 50.0 }));
    expect(r.amount.toNumber()).toBe(-50);
  });

  it("Plaid negative (inflow) → recon positive (deposit)", () => {
    // A typical Plaid deposit: amount is negative.
    const r = plaidMapperV1.map(buildTxn({ amount: -2500.0 }));
    expect(r.amount.toNumber()).toBe(2500);
  });

  it("Zero stays zero (degenerate but possible)", () => {
    const r = plaidMapperV1.map(buildTxn({ amount: 0 }));
    // Decimal.negated() of 0 returns -0; use isZero() for value equality.
    expect(r.amount.isZero()).toBe(true);
  });

  it("Preserves cents precision via Decimal", () => {
    const r = plaidMapperV1.map(buildTxn({ amount: 123.45 }));
    expect(r.amount.toFixed(2)).toBe("-123.45");
  });
});

describe("plaidMapperV1: description fallbacks", () => {
  it("Prefers `name` when present", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        name: "Acme Corp Wire",
        original_description: "WIRE OUT ACME CORP REF12345",
        merchant_name: "Acme Corp",
      })
    );
    expect(r.description).toBe("Acme Corp Wire");
  });

  it("Falls back to original_description when name is empty", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        name: "",
        original_description: "BANK WIRE INBOUND 4291",
      })
    );
    expect(r.description).toBe("BANK WIRE INBOUND 4291");
  });

  it("Falls back to merchant_name when name + original_description empty", () => {
    const r = plaidMapperV1.map(
      buildTxn({ name: "", original_description: null, merchant_name: "Stripe" })
    );
    expect(r.description).toBe("Stripe");
  });

  it("Uses synthetic placeholder when all description fields are absent", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        transaction_id: "abc12345xyz",
        name: "",
        original_description: null,
        merchant_name: null,
      })
    );
    expect(r.description).toContain("Plaid txn");
    expect(r.description).toContain("abc12345");
  });
});

describe("plaidMapperV1: currency fallback", () => {
  it("Uses iso_currency_code when present", () => {
    const r = plaidMapperV1.map(buildTxn({ iso_currency_code: "USD" }));
    expect(r.currencyCode).toBe("USD");
  });

  it("Falls back to unofficial_currency_code when iso is null", () => {
    const r = plaidMapperV1.map(
      buildTxn({ iso_currency_code: null, unofficial_currency_code: "BTC" })
    );
    expect(r.currencyCode).toBe("BTC");
  });

  it("Defaults to USD when both are null (Plaid sandbox quirk)", () => {
    const r = plaidMapperV1.map(
      buildTxn({ iso_currency_code: null, unofficial_currency_code: null })
    );
    expect(r.currencyCode).toBe("USD");
  });
});

describe("plaidMapperV1: dates + identifiers", () => {
  it("Preserves transaction_id as externalId", () => {
    const r = plaidMapperV1.map(buildTxn({ transaction_id: "txn-deadbeef" }));
    expect(r.externalId).toBe("txn-deadbeef");
  });

  it("Preserves account_id as externalAccountId", () => {
    const r = plaidMapperV1.map(buildTxn({ account_id: "acct-zyxwvu" }));
    expect(r.externalAccountId).toBe("acct-zyxwvu");
  });

  it("Parses YYYY-MM-DD date as UTC midnight (avoids TZ drift)", () => {
    const r = plaidMapperV1.map(buildTxn({ date: "2026-03-15" }));
    expect(r.transactionDate.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
});

describe("plaidMapperV1: optional fields", () => {
  it("Captures pending flag", () => {
    expect(plaidMapperV1.map(buildTxn({ pending: true })).pending).toBe(true);
    expect(plaidMapperV1.map(buildTxn({ pending: false })).pending).toBe(false);
  });

  it("Captures merchant_name (null-safe)", () => {
    expect(
      plaidMapperV1.map(buildTxn({ merchant_name: "Stripe" })).merchantName
    ).toBe("Stripe");
    expect(plaidMapperV1.map(buildTxn({ merchant_name: null })).merchantName).toBe(null);
  });

  it("Captures category array (null-safe)", () => {
    expect(
      plaidMapperV1.map(
        buildTxn({ category: ["Food and Drink", "Restaurants", "Coffee Shop"] })
      ).category
    ).toEqual(["Food and Drink", "Restaurants", "Coffee Shop"]);
    expect(plaidMapperV1.map(buildTxn({ category: null })).category).toBe(null);
  });
});

describe("plaidMapperV1: realistic accounting scenarios", () => {
  it("ACH credit (customer payment) maps to positive recon amount", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        amount: -5000.0,
        name: "ACH CR ACME CORP",
        date: "2026-03-15",
      })
    );
    expect(r.amount.toNumber()).toBe(5000);
    expect(r.description).toBe("ACH CR ACME CORP");
  });

  it("Wire out (vendor payment) maps to negative recon amount", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        amount: 3200.0,
        name: "WIRE OUT — AWS HOSTING",
        date: "2026-03-15",
      })
    );
    expect(r.amount.toNumber()).toBe(-3200);
  });

  it("Bank fee (small outflow) maps with correct sign + cents", () => {
    const r = plaidMapperV1.map(
      buildTxn({
        amount: 12.50,
        name: "MONTHLY MAINTENANCE FEE",
      })
    );
    expect(r.amount.toFixed(2)).toBe("-12.50");
  });
});

describe("plaidMapperV1: stability", () => {
  it("mapperVersion is a stable string identifier", () => {
    expect(plaidMapperV1.mapperVersion).toBe("plaid-mapper-v1");
  });

  it("map() is referentially transparent — same input, same output", () => {
    const input = buildTxn({ amount: 100.5, name: "Test" });
    const a = plaidMapperV1.map(input);
    const b = plaidMapperV1.map(input);
    expect(a.externalId).toBe(b.externalId);
    expect(a.amount.toString()).toBe(b.amount.toString());
    expect(a.description).toBe(b.description);
    expect(a.transactionDate.getTime()).toBe(b.transactionDate.getTime());
  });
});
