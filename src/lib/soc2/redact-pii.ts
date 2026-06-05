// PII redaction helper — Confidentiality TSC + CC7.3 (security event
// evaluation: errors shipped to monitoring must not contain PII).
//
// Why this exists:
//   integrations sits at the perimeter of the portfolio — every Plaid
//   webhook, every connector sync, every credential refresh runs raw
//   bank API responses + OAuth tokens through the boundary. When an
//   error fires mid-sync, the embedded values (transaction
//   descriptions, account numbers, raw access tokens) flow to Sentry
//   / Vercel logs verbatim by default. SOC 2 Confidentiality TSC
//   explicitly calls out monitoring exhaust as a leak vector.
//
// What it does:
//   `redactPii(value)` deep-clones the value and masks any property
//   whose name appears in the PII_FIELD_NAMES allowlist. Arrays are
//   traversed. Strings/numbers/null pass through unchanged.
//
// Discipline:
//   Conservative is correct — over-redaction is acceptable;
//   under-redaction is a SOC 2 finding. Add to the allowlist when a
//   new sensitive column lands; never remove an entry without a
//   coordinated schema audit.
//
// Mirror of ledger-core's `src/lib/soc2/index.ts` redactPii (PR #10)
// + fa-amort port (PR #21) + recon port (PR #24) + revenue-rec port
// (PR #28). integrations specifics: credentialsJson is the highest-
// sensitivity column here — encrypted at rest, but a raw OAuth access
// token leaking to monitoring is a Critical incident.

const PII_FIELD_NAMES = new Set<string>([
  // Identity (Clerk + portfolio User table)
  "email",
  "emailAddress",
  "displayName",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "phoneNumber",
  "address",
  "addressLine1",
  "addressLine2",
  // Auth (any token / secret that could grant access)
  "password",
  "token",
  "apiKey",
  "secret",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "clerkUserId", // pseudonymous but still subject identifier
  // Connector credentials — the LOAD-BEARING carve-out. A leaked
  // OAuth token here is a Critical incident (attacker can read /
  // write to the user's bank, Stripe, Gusto, etc.).
  "credentialsJson",
  "publicToken", // Plaid Link exchange artifact
  "itemId", // Plaid Item identifier (pseudo-PII)
  "linkSessionId",
  // Connector raw payloads — Plaid /transactions/sync responses,
  // Stripe charges, etc. Often contain full account numbers,
  // counterparty names, addresses.
  "rawRecord",
  "rawPayload",
  // Bank / financial — same as recon since integrations writes to
  // recon's BankStatementLine via the bridge.
  "accountNumber",
  "accountNumberLast4",
  "routingNumber",
  "bankName",
  "description",
  "memo",
  "notes",
]);

const REDACTED = "[REDACTED]";

/**
 * Deep-clone `value` with any property whose name is in PII_FIELD_NAMES
 * masked to "[REDACTED]". Arrays traversed; primitives pass through.
 *
 * Safe to call on any value — including unknown / never types from
 * caught errors. Returns the same shape as input.
 */
export function redactPii<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  // Special handling for Error objects — preserve the shape so the
  // caller can still see .name + .stack, but redact .message (which
  // often embeds user input).
  if (value instanceof Error) {
    return {
      name: value.name,
      message: REDACTED,
      stack: value.stack,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELD_NAMES.has(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(v);
    }
  }
  return out;
}

/**
 * The active allowlist — exported for unit tests + the SOC 2 audit
 * trail. Callers should never mutate this; the set is frozen-by-
 * convention (TypeScript doesn't enforce, but a code reviewer should).
 */
export const PII_FIELDS = PII_FIELD_NAMES;
