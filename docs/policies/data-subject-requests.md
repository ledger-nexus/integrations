# Data subject request procedure — integrations

**Owner:** Privacy lead (shared with the rest of the portfolio; see
`ledger-core/docs/policies/access-control.md`)
**Last reviewed:** 2026-06-02
**Defers to:** `ledger-core/docs/policies/data-subject-requests.md` — the
canonical, portfolio-wide procedure.

This document covers what's **unique to the `integrations` repo**: the
OAuth tokens + connection metadata it holds, and how a data-subject
request is honored against that data. The general procedure (channels,
identity verification, SLA, audit-logging) lives in `ledger-core` and
is NOT duplicated here.

---

## What personal data this repo holds

### `User` + `Tenant` + `TenantMembership` (replicated)

These tables are FK-convenience replicas of the canonical rows in
`ledger-core`. The replica is **read-mostly** — the canonical writes
live in `ledger-core` and the replication is async via the existing
sync paths. For DSR purposes, these are NOT independent records; an
erasure on `ledger-core` propagates to the replica on the next sync
cycle.

| Field | Classification | Notes |
|---|---|---|
| `User.email` | CONFIDENTIAL | Replica of the ledger-core column. Encrypted at rest via the shared field-encryption extension (PR #10 portfolio rollout). |
| `User.displayName` | CONFIDENTIAL | Replica; encrypted at rest. |
| `Tenant.name` | CONFIDENTIAL | Replica; encrypted at rest. |

### `Connection.credentialsJson` (CONFIDENTIAL — and high-value to attackers)

This is the integration-specific surface. Each `Connection` row holds
a connector-specific JSON blob — for Plaid, `{ accessToken, itemId,
institutionId, institutionName, accountId }`. The `accessToken` is a
long-lived secret that grants access to the user's bank account
metadata + transaction history.

| Field | Classification | Notes |
|---|---|---|
| `Connection.credentialsJson` | **RESTRICTED** | Long-lived bearer tokens for downstream SaaS systems. Treat as if it were a password. **Encrypted at rest** via the field-encryption extension (Json mode, mirrored from ledger-core). Never logged. |
| `Connection.displayName` | INTERNAL | Operator-facing label like "Chase Operating ****1234". The last-4 is a fragment of the bank account number but isn't enough to identify the customer in isolation. |

### `SyncRun` + `ImportStagingRecord` (INTERNAL)

Sync history + staged-but-unpromoted rows. May incidentally contain
bank transaction descriptions which can include merchant names,
counterparty references, and dollar amounts. These age out via the
ledger-core retention engine on the next portfolio rollout
(`automated-retention-engine` PR; see `ledger-core/src/lib/retention/policies.ts`).

---

## DSR procedure for THIS repo's data

### Right of access (Art. 15)

When a subject's export bundle is assembled in ledger-core, this
repo's contribution is:

1. Connections the subject (acting as an OWNER/ADMIN of a tenant) has
   created — surfaced via `Connection.targetId → BankAccount` ownership.
2. **Token fields are NEVER included in the export.** The
   `credentialsJson` blob is operator/system property, not subject
   data. The audit row for the request records `tokensIncluded: false`
   per Art. 15(4) (rights of others — the bank, not the subject, is
   the data-controller of the access token's grant).
3. Sync history attributable to the subject's connections — counts only,
   not the staged record contents.

The assembly helper for this repo's contribution lives at
`src/lib/privacy/connections-export.ts` (TODO when first DSR arrives;
the helper signature is documented but not yet implemented — placeholder
file with a typed stub will be added in the next PR).

### Right to erasure (Art. 17)

A user-erasure in ledger-core triggers connection-level handling here:

1. **Tokens get revoked at the source, not just deleted locally.** For
   each Plaid connection the subject created, call the Plaid
   `/item/remove` endpoint to invalidate the access token on Plaid's
   side. Without this step the connection is "deleted" in our DB but
   the token still grants third-party access.
2. **Then mark `Connection.status = REVOKED`** and rotate the
   `credentialsJson` to `{ revokedAt: <ts>, revokedReason: 'data_subject_erasure' }`.
   The row stays so the audit trail of "this connection used to
   exist" survives; the credential value is gone.
3. **Sync history is preserved** under the legal-retention exemption.
   The subject ID is replaced with the redacted user ID (same flow as
   ledger-core's erasure path); the financial event chain remains
   auditable.

The Plaid `/item/remove` call is implemented in
`src/lib/connectors/plaid/client.ts removeItem()`. The DSR-driven
revocation orchestrator is TODO (see same caveat as above).

### Right to rectification (Art. 16)

Not applicable to this repo. The User/Tenant replicas update via
ledger-core; connection metadata is operator-curated, not subject-curated.

### Right to portability (Art. 20)

Covered by the access export. No separate procedure.

---

## What an auditor asks for, and where it lives

| Auditor question | Where the answer lives |
|---|---|
| "Do you have a DSR procedure?" | `ledger-core/docs/policies/data-subject-requests.md` (canonical) + this file (this-repo scope) |
| "Show me where you store OAuth tokens" | `Connection.credentialsJson`, schema doc on the column |
| "Are those tokens encrypted at rest?" | `src/lib/db/encrypted-fields-extension.ts` — Json mode column registry |
| "When a subject is erased, how do you revoke their tokens?" | "Right to erasure" section above; `src/lib/connectors/plaid/client.ts removeItem` |
| "Show me proof that a revocation actually happened" | `audit_log` row of type `CONFIG_CHANGE/connection.revoked` (POSTed cross-repo to ledger-core's internal audit endpoint) |

---

## Open items (out of scope for this PR, tracked here for the next sprint)

1. **`src/lib/privacy/connections-export.ts`** — the typed stub. Today
   if a DSR comes in, the privacy lead has to query Postgres manually.
   The stub is a forcing function to wire the helper into the
   ledger-core export bundle's "external connections" section.
2. **DSR-driven revocation orchestrator** — wraps `Plaid removeItem`
   in the existing audit-event emission and handles non-Plaid
   connectors when they ship.
3. **Mirror to the other connectors** as they ship. The Plaid pattern
   (revoke at source, then mark local row REVOKED) is the canonical
   shape — every future connector documents the equivalent
   source-side revocation API.

These items are deliberately NOT blocking on this doc. The doc is the
artifact an auditor reads to verify "yes, they thought about this";
the implementation closes when a real request arrives.
