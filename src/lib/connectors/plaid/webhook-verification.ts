// Plaid webhook JWT verification.
//
// Plaid signs every webhook with an ES256 JWT in the `Plaid-Verification`
// header. To verify a request is really from Plaid we must:
//
//   1. Parse the JWT (header.payload.signature, base64url-encoded).
//   2. Confirm the header's alg is ES256 and pull the `kid`.
//   3. Fetch the public JWK for that kid from Plaid's
//      /webhook_verification_key/get endpoint (caching it in-process to
//      avoid hammering Plaid on every webhook).
//   4. Verify the ES256 signature over `<header>.<payload>` (base64url
//      strings concatenated with a literal dot) using the JWK.
//   5. Confirm the payload's `iat` (issued-at) is within 5 minutes of
//      now — defends against replay of old captured webhooks.
//   6. Confirm the payload's `request_body_sha256` matches the actual
//      SHA-256 hex digest of the request body bytes — defends against
//      anyone swapping the body while keeping the (signed) JWT.
//
// Reference: https://plaid.com/docs/api/webhooks/webhook-verification/
//
// Why hand-roll vs. pulling in `jose`:
//   - Node 20+ has everything we need (createPublicKey from JWK,
//     verify with ieee-p1363 raw r||s signatures).
//   - Avoiding another runtime dep keeps the integrations service lean
//     and removes a moving part that could ship a bad update.
//   - The verification logic is ~80 lines; the surface to read is
//     small enough to audit.

import { createPublicKey, createHash, verify, KeyObject } from "node:crypto";
import { webhookVerificationKeyGet } from "./client";
import type { PlaidWebhookVerificationKey } from "./types";

// Plaid's spec: webhook tokens are valid for 5 minutes from `iat`.
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

export interface VerifyPlaidWebhookInput {
  /** Verbatim request body bytes as received. Critical: must be the raw bytes; re-stringifying JSON will not match. */
  rawBody: string;
  /** Request headers, case-insensitively keyed by Node. Caller is expected to lowercase. */
  headers: Record<string, string | undefined>;
  /**
   * Test seam. Production callers omit this — the default fetches via
   * the Plaid SDK. Tests inject a stub returning a known JWK.
   */
  fetchKey?: (kid: string) => Promise<PlaidWebhookVerificationKey>;
  /** Test seam for replay-window math. Defaults to Date.now(). */
  nowMs?: () => number;
}

export type VerifyPlaidWebhookResult =
  | { ok: true; kid: string }
  | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// In-process JWK cache
// ─────────────────────────────────────────────────────────────────────────────
//
// Plaid documents key rotation; a kid we've seen is reusable for the
// lifetime of that key's validity. We cache the converted KeyObject (so
// we skip the JWK→KeyObject conversion on hot paths too) keyed by kid.
//
// Expired keys are dropped on read — never serve a verification from an
// expired key. The cache is bounded by the number of distinct kids Plaid
// uses (small, single digits in practice), so no LRU is needed.

interface CacheEntry {
  key: KeyObject;
  expiredAt: number | null; // unix seconds; null = current
}

const keyCache = new Map<string, CacheEntry>();

/** Test helper. Clears the in-process key cache. Not for production callers. */
export function _clearKeyCacheForTesting(): void {
  keyCache.clear();
}

async function loadKey(
  kid: string,
  fetchKey: (kid: string) => Promise<PlaidWebhookVerificationKey>,
  nowSeconds: number
): Promise<{ ok: true; key: KeyObject } | { ok: false; reason: string }> {
  const cached = keyCache.get(kid);
  if (cached) {
    if (cached.expiredAt !== null && cached.expiredAt <= nowSeconds) {
      keyCache.delete(kid);
    } else {
      return { ok: true, key: cached.key };
    }
  }

  let jwk: PlaidWebhookVerificationKey;
  try {
    jwk = await fetchKey(kid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return { ok: false, reason: `Failed to fetch verification key for kid=${kid}: ${msg}` };
  }

  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.alg !== "ES256") {
    return {
      ok: false,
      reason: `Unsupported JWK shape for kid=${kid}: kty=${jwk.kty} crv=${jwk.crv} alg=${jwk.alg}`,
    };
  }
  if (jwk.expired_at !== null && jwk.expired_at <= nowSeconds) {
    return { ok: false, reason: `Verification key kid=${kid} is expired` };
  }

  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({
      key: {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x,
        y: jwk.y,
      },
      format: "jwk",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return { ok: false, reason: `Failed to materialize public key for kid=${kid}: ${msg}` };
  }

  keyCache.set(kid, { key: keyObject, expiredAt: jwk.expired_at });
  return { ok: true, key: keyObject };
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64url decoding (Node's Buffer supports it natively from 16+)
// ─────────────────────────────────────────────────────────────────────────────

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

interface ParsedJwt {
  header: { alg?: string; kid?: string; typ?: string };
  payload: { iat?: number; request_body_sha256?: string };
  signingInput: string;
  signature: Buffer;
}

function parseJwt(token: string): { ok: true; jwt: ParsedJwt } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "JWT must have three dot-separated segments" };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: ParsedJwt["header"];
  let payload: ParsedJwt["payload"];
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "JWT header is not valid JSON" };
  }
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "JWT payload is not valid JSON" };
  }

  const signature = base64urlDecode(sigB64);
  // ES256 raw signature: 32-byte r || 32-byte s = 64 bytes.
  if (signature.length !== 64) {
    return {
      ok: false,
      reason: `Unexpected ES256 signature length: got ${signature.length}, want 64`,
    };
  }

  return {
    ok: true,
    jwt: {
      header,
      payload,
      signingInput: `${headerB64}.${payloadB64}`,
      signature,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Body-hash check
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Constant-time string compare for hex digests. Both inputs are
// attacker-uninfluenced lengths (always 64 chars for SHA-256 hex), but
// constant-time is the conservative default.
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyPlaidWebhook(
  input: VerifyPlaidWebhookInput
): Promise<VerifyPlaidWebhookResult> {
  const headerToken = input.headers["plaid-verification"];
  if (!headerToken) {
    return { ok: false, reason: "Missing Plaid-Verification header" };
  }

  const parsed = parseJwt(headerToken);
  if (!parsed.ok) return parsed;
  const jwt = parsed.jwt;

  if (jwt.header.alg !== "ES256") {
    return { ok: false, reason: `Unexpected JWT alg: ${jwt.header.alg ?? "(missing)"} (expected ES256)` };
  }
  const kid = jwt.header.kid;
  if (!kid || typeof kid !== "string") {
    return { ok: false, reason: "JWT header missing kid" };
  }

  const nowMs = (input.nowMs ?? Date.now)();
  const nowSeconds = Math.floor(nowMs / 1000);

  const fetchKey = input.fetchKey ?? webhookVerificationKeyGet;
  const keyResult = await loadKey(kid, fetchKey, nowSeconds);
  if (!keyResult.ok) return keyResult;

  // Verify the ES256 signature over the signing input.
  let signatureValid = false;
  try {
    signatureValid = verify(
      "sha256",
      Buffer.from(jwt.signingInput, "utf8"),
      {
        key: keyResult.key,
        // Plaid emits raw r||s per JWS; Node defaults to DER.
        dsaEncoding: "ieee-p1363",
      },
      jwt.signature
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return { ok: false, reason: `Signature verification threw: ${msg}` };
  }
  if (!signatureValid) {
    return { ok: false, reason: "Signature is invalid for this kid" };
  }

  // Replay defense: iat must be recent. iat is unix seconds.
  if (typeof jwt.payload.iat !== "number") {
    return { ok: false, reason: "JWT payload missing iat" };
  }
  const ageSeconds = nowSeconds - jwt.payload.iat;
  // Allow tiny clock skew in either direction; treat future-dated >60s as bad.
  if (ageSeconds > MAX_TOKEN_AGE_SECONDS) {
    return {
      ok: false,
      reason: `JWT is stale: iat=${jwt.payload.iat} age=${ageSeconds}s (max ${MAX_TOKEN_AGE_SECONDS}s)`,
    };
  }
  if (ageSeconds < -60) {
    return {
      ok: false,
      reason: `JWT iat is in the future: iat=${jwt.payload.iat} now=${nowSeconds}`,
    };
  }

  // Body-hash check: the signed claim must match the actual body.
  if (typeof jwt.payload.request_body_sha256 !== "string") {
    return { ok: false, reason: "JWT payload missing request_body_sha256" };
  }
  const actualHash = sha256Hex(input.rawBody);
  if (!constantTimeEqualHex(actualHash, jwt.payload.request_body_sha256)) {
    return {
      ok: false,
      reason: "Request body SHA-256 does not match the signed JWT claim",
    };
  }

  return { ok: true, kid };
}
