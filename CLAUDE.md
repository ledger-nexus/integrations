<!-- BEGIN multi-session-orchestrator amendment (v1) -->

## ⚠️ Multi-session coordination (READ FIRST)

This repo may have parallel Claude sessions — they clobber each other's writes without coordination.

1. **Read `STATUS.md`** at the repo root before editing any file. If your task overlaps an active claim, pick a different task or surface the conflict to the user.
2. **Claim your scope** before your first edit: append a `### Session <id>` block to STATUS.md under "Active claims" with scope / files-globs / branch / heartbeat (format documented in STATUS.md). Commit STATUS.md atomically.
3. **Heartbeat** every ~20 turns. Small commit.
4. **Release** at session end: move your block to "Recent completions" with an outcome line. Commit.

Never edit another session's claim, skip the read, or claim `**`.

<!-- END multi-session-orchestrator amendment -->

# Claude Code Instructions for integrations

Auto-loaded by Claude Code on every session in this repo.

## What this project is

`integrations` is the data-integration engine in the `ledger-nexus` portfolio. It pulls operational data from third-party SaaS systems (Plaid for banks, Stripe / PayPal for payments, Gusto for payroll, Bill.com for AP) and pushes it into the substrate via the existing HTTP boundaries on ledger-core and recon. Think of it as a stripped-down, accounting-aware Celigo / Mulesoft.

v0.1 ships **the connector pattern + one real connector (Plaid)** end-to-end. Plaid is the natural first choice because it feeds the most mature downstream consumer (recon) — bank-feed ingestion replaces the most tedious manual step in the existing CSV-upload workflow.

The architecture canon is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read it before changing how connectors talk to the downstream consumers.

## The non-negotiables

1. **One connector pattern, hand-coded.** Each integration is a TypeScript module at `src/lib/connectors/<system>/` implementing the `Connector<T>` interface from `src/lib/connectors/interface.ts`. NO JSON-config DSL, NO drag-and-drop builder. We have explicit types and they pay for themselves.

2. **Connector mappers are pure functions.** No I/O, no DB access. Mapping is `(raw: TRecord) => TMapped` and gets unit-tested in isolation. Mapper version is stamped on every staged row.

3. **Engine writes downstream via HTTP bridges.** integrations POSTs mapped records to recon's `POST /api/internal/bank-lines` endpoint (token-gated, mirror of ledger-core's `/api/internal/journal-entries`). NO direct DB writes to recon's owned tables; the bridge in `src/lib/recon-bridge.ts` is an HTTP client only. Server-side dedup by `externalRef` makes overlapping sync windows safe.

4. **No flow engine.** Per-event handlers in TypeScript code, not a visual flow builder. Zapier / Make / n8n already do that; our value is the deep, accounting-aware connectors.

5. **Cursor advances ONLY on successful sync.** Failed syncs leave the cursor untouched so the next attempt picks up the same window. This is the whole point of `/transactions/sync`-style cursor APIs vs. timestamp-based pagination.

6. **All error emission goes through the monitoring shim.** `src/lib/monitoring/index.ts` is the canonical path — `captureError(err, context)` / `captureMessage(msg, level, context)`. Every emit runs `redactPii()` before the error reaches Sentry or the console fallback. **Never call Sentry directly + never console.error a Plaid/Stripe error's `.message`** — vendor errors regularly embed the raw access token + transaction descriptions. **Load-bearing for integrations:** a leaked OAuth `accessToken` in Sentry's UI is a Critical incident class (attacker gets bank/Stripe/Gusto access). The shim's `sanitizeErrorForCapture()` strips the V8 stack preamble so `.message` PII can't leak via `.stack` (14th adversarial pass closure 2026-06-05). Add new field names to `src/lib/soc2/redact-pii.ts` allowlist when new vendor identifiers ship — `plaidItemId`, `stripeCustomerId`, `gustoEmployeeId`, `linkToken` were added in the 14th-pass closure.

## SOC 2 + adversarial-pass cadence

This repo is part of the ledger-nexus portfolio's SOC 2 Type 2 readiness program. Current state (per `ledger-core/docs/SOC2_READINESS.md`): **≈80% to Type 1 audit-ready**.

**Adversarial-pass discipline:** every substantive code shipment (new connector, webhook receiver, OAuth flow, monitoring code, anything cross-tenant-touching) should be followed by an adversarial-pass audit before merge. The portfolio has run **14 adversarial passes** to date; the 14th-pass closure on the Sentry shim is the LOAD-BEARING case here:

- **14th pass (2026-06-05 night):** found Error.stack PII leak via V8 preamble (Confidentiality TSC) + integrations vendor-identifier gaps in PII allowlist — closed via integrations PR #18 2nd commit. The integrations port pins a Critical-tier test: `"Plaid sync failed for token plk-secret-abcdef-12345"` cannot reach Sentry's index via the sanitized stack.

The cadence is the evidence: SOC 2 CC4 (Monitoring Activities) auditors grade "this team finds + closes their own weaknesses." A self-discovered HIGH closed in-session with tests pinning the attack scenario is the highest-confidence CC4 evidence form. **When you ship something load-bearing (especially OAuth flows + webhook receivers), run an adversarial pass before declaring done.**

## What's wired (v0.1)

- **Connector interface** ([`src/lib/connectors/interface.ts`](src/lib/connectors/interface.ts)) — `Connector<TRecord, TPush>` generic + `ConnectorMeta` + `ConnectorMapper` + auth/fetch/push/webhook input+result types.
- **Plaid connector** ([`src/lib/connectors/plaid/`](src/lib/connectors/plaid/)) — types, client wrapper, mapper, connector. Implements polling via `/transactions/sync`. Webhooks deferred to v0.2.
- **Sync runner** ([`src/lib/sync/runner.ts`](src/lib/sync/runner.ts)) — orchestrator: load Connection → call connector.fetchSince → stage records → run mapper → promote to recon. Single-connection lock via `lastSyncStatus=RUNNING`.
- **recon bridge** ([`src/lib/recon-bridge.ts`](src/lib/recon-bridge.ts)) — direct DB write to `BankStatement` + `BankStatementLine`. Idempotency via `externalRef` (Plaid transaction_id) dedup before insert.
- **Schema** — Connection, SyncRun, ImportStagingRecord (owned) + LegalEntity, Account, BankAccount, BankStatement, BankStatementLine (mirrored from recon).
- **UI** (port 3003): dashboard, connections list, connection detail, new-connection page with `<PlaidLinkButton />` Client Component.
- **Tests**: 32 unit tests across mapper + connector-interface conformance. No DB needed; runs anywhere.

## What's next (v0.2 ideas)

- **Webhook receivers** — Plaid TRANSACTIONS_UPDATES_AVAILABLE events trigger an immediate sync without polling
- **Scheduled syncs** — pg_boss background worker; nightly sync per active connection
- **HTTP bridge to recon** — replace direct DB write with POST to a recon internal endpoint (symmetric with ledger-core bridge)
- **More connectors** — Stripe (payments → AR open items), Gusto (payroll → JE via posting-rules), Bill.com (vendor invoices → AP open items)
- **AI-assisted field mapping** — Claude proposes mappings when a new connector's schema doesn't match an existing pattern
- **Multi-account flows** — single Plaid Item with checking + savings + credit card → multiple Connection rows, one per account
- **Modified + removed transaction handling** — Plaid signals transaction updates / cancellations; v0.1 ignores both. v0.2 should propagate.

## Stack

- Next.js 14 (App Router), port 3003 (ledger-core 3000, recon 3001, revenue-rec 3002)
- Postgres + Prisma (shared with ledger-core / recon / revenue-rec)
- Plaid Node SDK (`plaid` package) + `react-plaid-link` for the client widget
- decimal.js for money math (sign-flip is the most error-prone bit)
- Vitest for tests (mapper + interface conformance)
- Tailwind + inlined UI primitives

## Rules for working in this codebase

### Adding a new connector

Five steps. See [`docs/adding-a-connector.md`](docs/adding-a-connector.md) for the full recipe.

1. Create `src/lib/connectors/<system>/` with `types.ts`, `client.ts`, `mapper.ts`, `connector.ts`.
2. Implement the `Connector<TRecord>` interface. Required methods: `meta`, `initiateAuth`, `completeAuth`, `fetchSince`. Optional: `pushRecord`, `verifyWebhookSignature`, `parseWebhookEvent`.
3. Add the connector to `CONNECTOR_REGISTRY` in `src/lib/sync/runner.ts`.
4. Decide the downstream target: `BANK_ACCOUNT` (writes to recon) or future types (PARTY, VENDOR, GL_ACCOUNT, EMPLOYEE). For new targets, add a bridge module like `recon-bridge.ts`.
5. Write unit tests for the mapper. Connector-interface conformance is enforced by tsc.

### Credentials

Connector credentials are an opaque JSON blob persisted to `Connection.credentialsJson`. The shape is connector-defined. Never log credentials. Treat the `accessToken` (Plaid) / API key fields as the secrets they are.

### Idempotency

Every record from a connector carries an `externalId`. The `ImportStagingRecord` table has a unique constraint on `(syncRunId, externalId)`. Downstream writes (recon's `BankStatementLine.externalRef`) ALSO use externalId for dedup. A sync that runs twice over an overlapping window does NOT create duplicate ledger entries.

### Cursor discipline

The sync runner advances `Connection.lastCursor` ONLY on `SUCCESS`. On failure, the cursor stays put. This means a flaky network / connector outage doesn't lose data — the next sync picks up at the same point and processes any missed records.

### UI work

Same conventions as ledger-core / recon / revenue-rec: App Router, Server Components by default, Server Actions for mutations, inline UI primitives in `src/components/ui/`. The one Client Component is `<PlaidLinkButton />` because Plaid Link requires React hooks for the widget lifecycle.

## How to start a session

1. Read this file.
2. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the connector pattern + cross-repo write story).
3. Confirm: does this work belong in integrations (third-party data pulls / pushes) or in recon (matching) / ledger-core (substrate writes)?
