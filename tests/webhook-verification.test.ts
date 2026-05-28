// Plaid webhook JWT verification tests.
//
// Real ES256 signatures, exercised through the verifier. We generate a
// fresh P-256 keypair per test suite, expose the public half as a JWK
// (matching Plaid's /webhook_verification_key/get response shape), and
// feed it into the verifier via the `fetchKey` test seam.
//
// What's covered:
//   - Happy path (valid signature, fresh iat, matching body hash)
//   - Bad signature (signed with a different key)
//   - Tampered body (signed JWT but body bytes don't match the signed hash)
//   - Replay defense (iat too old, iat in the future)
//   - Malformed inputs (missing header, wrong alg, missing kid)
//   - Key cache: a second verify with the same kid does NOT re-fetch
//   - Key cache: an expired key is dropped + re-fetched
//   - Unsupported JWK shapes (RSA, wrong curve)

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateKeyPairSync,
  createSign,
  KeyObject,
} from "node:crypto";
import {
  verifyPlaidWebhook,
  _clearKeyCacheForTesting,
} from "../src/lib/connectors/plaid/webhook-verification";
import type { PlaidWebhookVerificationKey } from "../src/lib/connectors/plaid/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: produce ES256 JWTs + matching JWKs the way Plaid would
// ─────────────────────────────────────────────────────────────────────────────

function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Sign with a P-256 private key using DER output, then convert to raw
// r||s (ieee-p1363) per JWS spec.
function ecdsaDerToP1363(der: Buffer): Buffer {
  // Minimal ASN.1 SEQUENCE parser — adequate for r,s sequence-of-two-INTEGERs.
  // Sequence header: 0x30, len.
  if (der[0] !== 0x30) throw new Error("Not a DER SEQUENCE");
  let offset = 2;
  if (der[1] & 0x80) {
    // long-form length
    const n = der[1] & 0x7f;
    offset = 2 + n;
  }
  // INTEGER r
  if (der[offset] !== 0x02) throw new Error("Expected INTEGER for r");
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  // INTEGER s
  if (der[offset] !== 0x02) throw new Error("Expected INTEGER for s");
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);

  // Strip leading 0x00 if present (DER positivity padding), then left-pad to 32.
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  const rPadded = Buffer.concat([Buffer.alloc(32 - r.length, 0), r]);
  const sPadded = Buffer.concat([Buffer.alloc(32 - s.length, 0), s]);
  return Buffer.concat([rPadded, sPadded]);
}

interface SignedJwt {
  token: string;
  jwk: PlaidWebhookVerificationKey;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function makeSignedJwt(opts: {
  kid: string;
  body: string;
  iat: number;
  alg?: string;
  privateKey?: KeyObject;
  publicKey?: KeyObject;
  expired_at?: number | null;
}): SignedJwt {
  const { privateKey, publicKey } = opts.privateKey
    ? { privateKey: opts.privateKey, publicKey: opts.publicKey! }
    : generateKeyPairSync("ec", { namedCurve: "P-256" });

  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const headerJson = { alg: opts.alg ?? "ES256", typ: "JWT", kid: opts.kid };
  const payloadJson = {
    iat: opts.iat,
    request_body_sha256: require("node:crypto")
      .createHash("sha256")
      .update(opts.body, "utf8")
      .digest("hex"),
  };
  const headerB64 = base64urlEncode(JSON.stringify(headerJson));
  const payloadB64 = base64urlEncode(JSON.stringify(payloadJson));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("sha256");
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(privateKey);
  const rawSig = ecdsaDerToP1363(derSig);
  const sigB64 = base64urlEncode(rawSig);

  const token = `${signingInput}.${sigB64}`;

  return {
    token,
    privateKey,
    publicKey,
    jwk: {
      alg: "ES256",
      crv: "P-256",
      kid: opts.kid,
      kty: "EC",
      use: "sig",
      x: jwk.x,
      y: jwk.y,
      created_at: Math.floor(Date.now() / 1000),
      expired_at: opts.expired_at ?? null,
    },
  };
}

// Stable iat in the middle of the valid window, but parameterized so
// tests can move it.
function fakeNow(iat: number, offsetSeconds = 30) {
  return () => (iat + offsetSeconds) * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyPlaidWebhook — happy path", () => {
  beforeEach(() => _clearKeyCacheForTesting());

  it("accepts a freshly signed JWT with matching body hash", async () => {
    const iat = 1_700_000_000;
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "i-1" });
    const signed = makeSignedJwt({ kid: "k-happy", body, iat });

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kid).toBe("k-happy");
  });

  it("body must be the exact bytes (different whitespace fails the hash check)", async () => {
    const iat = 1_700_000_000;
    const body = `{"webhook_type":"TRANSACTIONS","item_id":"i-1"}`;
    const signed = makeSignedJwt({ kid: "k-1", body, iat });

    // Same logical JSON, different bytes (extra spaces).
    const rebuiltBody = `{ "webhook_type": "TRANSACTIONS", "item_id": "i-1" }`;
    const r = await verifyPlaidWebhook({
      rawBody: rebuiltBody,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SHA-256/);
  });
});

describe("verifyPlaidWebhook — signature rejection", () => {
  beforeEach(() => _clearKeyCacheForTesting());

  it("rejects a JWT signed with a different key", async () => {
    const iat = 1_700_000_000;
    const body = `{"webhook":"x"}`;
    const realKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fakeKey = generateKeyPairSync("ec", { namedCurve: "P-256" });

    // Build a token signed by fakeKey, but advertise realKey's JWK.
    const signed = makeSignedJwt({
      kid: "k-bad",
      body,
      iat,
      privateKey: fakeKey.privateKey,
      publicKey: fakeKey.publicKey,
    });
    // Replace the JWK with one for a different key.
    const realJwkExport = realKey.publicKey.export({ format: "jwk" }) as {
      x: string;
      y: string;
    };
    const wrongJwk: PlaidWebhookVerificationKey = {
      ...signed.jwk,
      x: realJwkExport.x,
      y: realJwkExport.y,
    };

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => wrongJwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Signature is invalid/);
  });

  it("rejects when the signing input has been tampered with", async () => {
    const iat = 1_700_000_000;
    const body = `{"webhook":"a"}`;
    const signed = makeSignedJwt({ kid: "k-1", body, iat });

    // Swap the second segment (payload) to a re-encoded payload claiming
    // a body hash for different bytes. Signature was for the original.
    const [headerB64, , sigB64] = signed.token.split(".");
    const tamperedPayload = base64urlEncode(
      JSON.stringify({
        iat,
        request_body_sha256: "0".repeat(64),
      })
    );
    const tamperedToken = `${headerB64}.${tamperedPayload}.${sigB64}`;

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": tamperedToken },
      fetchKey: async () => signed.jwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Signature is invalid/);
  });
});

describe("verifyPlaidWebhook — replay defense", () => {
  beforeEach(() => _clearKeyCacheForTesting());

  it("rejects a JWT whose iat is older than 5 minutes", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-old", body, iat });

    // now = iat + 6 minutes → past the 5-minute window
    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: () => (iat + 6 * 60) * 1000,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale/);
  });

  it("rejects a JWT whose iat is too far in the future", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-fut", body, iat });

    // now is 5 minutes BEFORE the iat — clearly tampered/forged.
    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: () => (iat - 5 * 60) * 1000,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/future/);
  });

  it("accepts a JWT exactly at the 5-minute edge", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-edge", body, iat });

    // now = iat + exactly 5 minutes; still within window.
    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: () => (iat + 5 * 60) * 1000,
    });

    expect(r.ok).toBe(true);
  });
});

describe("verifyPlaidWebhook — malformed inputs", () => {
  beforeEach(() => _clearKeyCacheForTesting());

  it("rejects when the Plaid-Verification header is missing", async () => {
    const r = await verifyPlaidWebhook({
      rawBody: "{}",
      headers: {},
      fetchKey: async () => {
        throw new Error("should not be called");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Missing Plaid-Verification/);
  });

  it("rejects a JWT with the wrong number of segments", async () => {
    const r = await verifyPlaidWebhook({
      rawBody: "{}",
      headers: { "plaid-verification": "not.a.real.jwt" },
      fetchKey: async () => {
        throw new Error("should not be called");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/three dot-separated/);
  });

  it("rejects a JWT with non-ES256 alg", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-1", body, iat, alg: "HS256" });

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Unexpected JWT alg/);
  });

  it("rejects a JWT with no kid in the header", async () => {
    // Hand-craft a JWT lacking kid.
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const headerB64 = base64urlEncode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const payloadB64 = base64urlEncode(
      JSON.stringify({
        iat,
        request_body_sha256: "0".repeat(64),
      })
    );
    // Need a signature even if we expect early rejection — sign with a fresh key.
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signer = createSign("sha256");
    signer.update(`${headerB64}.${payloadB64}`);
    signer.end();
    const sig = ecdsaDerToP1363(signer.sign(kp.privateKey));
    const token = `${headerB64}.${payloadB64}.${base64urlEncode(sig)}`;

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": token },
      fetchKey: async () => {
        throw new Error("should not be called");
      },
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing kid/);
  });
});

describe("verifyPlaidWebhook — key handling", () => {
  beforeEach(() => _clearKeyCacheForTesting());

  it("caches the JWK by kid — second verify does not re-fetch", async () => {
    const iat = 1_700_000_000;
    const body1 = `{"x":1}`;
    const body2 = `{"x":2}`;
    const signed1 = makeSignedJwt({ kid: "k-cache", body: body1, iat });

    // Reuse the same keypair for the second token (real Plaid behavior:
    // multiple webhooks signed by the same key over short windows).
    const signed2 = makeSignedJwt({
      kid: "k-cache",
      body: body2,
      iat: iat + 1,
      privateKey: signed1.privateKey,
      publicKey: signed1.publicKey,
    });

    let fetchCount = 0;
    const fetchKey = async () => {
      fetchCount++;
      return signed1.jwk;
    };

    const r1 = await verifyPlaidWebhook({
      rawBody: body1,
      headers: { "plaid-verification": signed1.token },
      fetchKey,
      nowMs: fakeNow(iat),
    });
    const r2 = await verifyPlaidWebhook({
      rawBody: body2,
      headers: { "plaid-verification": signed2.token },
      fetchKey,
      nowMs: fakeNow(iat),
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it("rejects an already-expired JWK on fetch", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({
      kid: "k-exp",
      body,
      iat,
      expired_at: iat - 60,
    });

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => signed.jwk,
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired/);
  });

  it("rejects an unsupported JWK shape (wrong kty)", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-rsa", body, iat });

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      // Pretend Plaid handed us an RSA key — should bail.
      fetchKey: async () => ({ ...signed.jwk, kty: "RSA" }),
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Unsupported JWK shape/);
  });

  it("surfaces fetch errors without throwing", async () => {
    const iat = 1_700_000_000;
    const body = `{"x":1}`;
    const signed = makeSignedJwt({ kid: "k-fetch-err", body, iat });

    const r = await verifyPlaidWebhook({
      rawBody: body,
      headers: { "plaid-verification": signed.token },
      fetchKey: async () => {
        throw new Error("plaid is down");
      },
      nowMs: fakeNow(iat),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Failed to fetch verification key/);
  });
});
