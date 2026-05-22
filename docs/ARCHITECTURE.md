# integrations architecture

How the integration engine relates to the rest of the portfolio, and the rationale for the connector pattern.

## The portfolio shape after this repo

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Postgres                                    │
│             ledger_core schema (shared by all four repos)                    │
└─────────────────────────────────────────────────────────────────────────────┘
        ▲                ▲                  ▲                     ▲
        │                │                  │                     │
        │ write via      │ write via        │ write via           │ write
        │ postJournal    │ postJournal      │ postJournal         │ direct
        │ + own tables   │ + own tables     │ + own tables        │ to recon
        │                │                  │                     │ tables
   ┌────┴─────┐    ┌────┴─────┐    ┌────────┴────────┐    ┌──────┴──────┐
   │ ledger-  │    │  recon   │    │  revenue-rec    │    │integrations │
   │  core    │    │  :3001   │    │     :3002       │    │   :3003     │
   │  :3000   │    │          │    │                 │    │             │
   │          │    │ Bank rec │    │ ASC 606         │    │ Plaid feeds │
   │ Substrate│    │ AI matchr│    │ AI extractor    │    │ (v0.1)      │
   │  + 9     │    │ Bridge → │    │ Bridge → core   │    │ Stripe /    │
   │ reports  │    │ core     │    │                 │    │  Gusto /    │
   │          │    │          │    │                 │    │  Bill v0.2+ │
   └──────────┘    └──────────┘    └─────────────────┘    └─────────────┘
                         ▲                                       │
                         │                                       │
                         └───────────────────────────────────────┘
                            v0.1: direct DB write
                            v0.2: refactor to HTTP POST
                                  to recon's /api/internal/bank-lines
```

The integration repo is the **fourth consumer** of the substrate. ledger-core remains the canonical write boundary for journal entries; recon remains the canonical write boundary for reconciliation matches and adjustment JEs. integrations adds a new write target: bank-statement ingestion that lands in recon's `BankStatementLine` table, ready for recon's matcher.

## Why a separate repo

The integration domain is fundamentally different from accounting:

| Concern | ledger-core / recon / revenue-rec | integrations |
|---|---|---|
| Cadence of change | Schema is stable (universal accounting model) | Connectors break monthly (Plaid changes APIs, Stripe adds events) |
| Runtime model | Read-heavy reports, write on Server Actions | Continuous polling, webhook receivers, background workers (v0.2+) |
| Test surface | Pure-function math + invariant tests | API mocks, contract tests, webhook signature verification |
| Failure modes | Bad ledger math (rare, caught by invariants) | Rate limits, schema drift, OAuth expiry, network flakes (constant) |
| Conceptual coupling | Accounting domain | Transport / orchestration domain |

Plus there's a practical concern: an AI-assisted integration platform for accounting is itself a viable product (Workato is a multi-billion-dollar company doing approximately this). Keeping it separate lets it be that thing.

## The connector pattern

Every third-party system is a self-contained module at `src/lib/connectors/<system>/`:

```
src/lib/connectors/<system>/
├── types.ts        — narrow subset of the system's record types
├── client.ts       — thin wrapper around the system's SDK (auth, fetch endpoints)
├── mapper.ts       — pure (raw: TRecord) => TMapped function
└── connector.ts    — implements Connector<TRecord> interface
```

The `Connector<TRecord, TPush>` interface (see [`src/lib/connectors/interface.ts`](../src/lib/connectors/interface.ts)) declares:

- **Identity**: `meta` (systemCode, displayName, targetType, capabilities flags)
- **Auth**: `initiateAuth` (returns linkToken or authUrl), `completeAuth` (returns persistable credentials)
- **Pull**: `fetchSince` (AsyncIterable streaming pages of records since a cursor)
- **Push** (optional): `pushRecord` (for connectors that support write-back)
- **Webhook** (optional): `verifyWebhookSignature` + `parseWebhookEvent`

The engine (sync runner, webhook router) is recordType-agnostic. It dispatches on `meta.systemCode` and invokes the right methods based on `meta.capabilities`.

## Disciplines we hold

### 1. Connector mappers are pure

`mapper.ts` exports a `ConnectorMapper<TRecord, TMapped>` — `(raw) => mapped`. No I/O. No database. No conditional behavior based on environment. This makes mappers trivially unit-testable; the test suite for Plaid's mapper exercises every coercion edge case (sign flips, currency fallbacks, description preference order, null handling) without any infrastructure.

`mapperVersion` is stamped on every staging record. If we change mapping logic, old staged records keep their original interpretation; new records use the new version. Avoids the "silently re-mapped history" failure mode.

### 2. Cursor advances only on success

`runConnectionSync` advances `Connection.lastCursor` ONLY when the sync run reaches `SUCCESS`. Partial failures keep the cursor unmoved. This means:

- Network blip → retry from the same point on the next run, no data loss
- Connector raises mid-stream → cursor unmoved, staged records retained for replay
- recon write fails on some records → cursor advances (records exist in staging), failed promotions surface separately

### 3. Idempotency at every layer

- `ImportStagingRecord` has unique `(syncRunId, externalId)` — re-running a sync within the same window doesn't double-stage
- `BankStatementLine.externalRef` is set to Plaid's `transaction_id` — `promoteToBankStatement` filters out already-imported externalIds before insert
- `Connection` has unique `(systemCode, targetId)` — can't accidentally connect the same Plaid Item to the same BankAccount twice

### 4. Credentials are opaque

`Connection.credentialsJson` is a JSON blob whose shape is connector-defined. The engine treats it as bytes; only the connector knows the structure. This:

- Makes adding a new auth model (OAuth2 with refresh tokens, API key + secret, JWT signing key) zero-impact to the engine
- Prevents accidental cross-connector field assumptions
- Limits credential leakage — generic engine code never reads `accessToken` or similar by name

## Cross-repo write story

**v0.1 (current)**: integrations writes directly to recon's `BankStatement` + `BankStatementLine` via the shared Postgres database. This is the same pattern recon and revenue-rec use to write to their own owned tables. It works because the four repos share one DB.

**v0.2 (planned)**: refactor to POST to a new `POST /api/internal/bank-lines` endpoint on recon. Symmetric with ledger-core's existing `/api/internal/journal-entries` HTTP boundary that recon and revenue-rec use today. After the refactor:

- integrations no longer mirrors recon's bank_* schema (the wire contract is the API, not the table)
- recon learns about each data source (filename, format, sync run id) explicitly
- integrations can be deployed independently of recon
- recon can audit / log inbound writes the same way it audits journal-entry writes

The Server-Action API in `src/lib/recon-bridge.ts` is shaped so the refactor changes the implementation without touching callers.

## Plaid choice + architecture for v0.1

Why Plaid first:
- Free sandbox tier (no upfront cost for development)
- `/transactions/sync` is a cursor-based API designed for the exact pattern the engine implements
- Token model is well-documented + minimal (long-lived `access_token` that never expires)
- Downstream consumer (recon) is the most mature surface in the portfolio
- Bank-feed ingestion is the universally-understood use case for "integration with an accounting system"

Plaid-specific quirks worth knowing:
- **Sign convention**: Plaid signs amounts opposite to recon (Plaid positive = outflow; recon positive = inflow). The mapper flips the sign. Tests assert both directions explicitly.
- **Multi-account Items**: a single Plaid Item (one bank login) can have multiple sub-accounts (checking + savings + credit card). v0.1 picks the first depository account at connect time. v0.2 will support multi-account flows.
- **Webhooks**: Plaid sends TRANSACTIONS_UPDATES_AVAILABLE events instead of pushing the records themselves. v0.2 will receive these and trigger an immediate poll. v0.1 polls on manual trigger only.
- **Modified + removed transactions**: Plaid's `/transactions/sync` returns three arrays (added, modified, removed). v0.1 ignores modified + removed — they're a v0.2 concern requiring downstream recon updates we haven't built yet.

## Cost framing

The "Celigo-lite at next to no money" claim:

| Component | Cost at modest volume |
|---|---|
| Postgres | $0–25/mo (shared with the rest of the portfolio; Neon hobby or Supabase) |
| Hosting | $0–20/mo (Vercel hobby or fly.io) |
| Plaid Sandbox | $0 |
| Plaid Production | ~$0.30 / connected account / month |
| Stripe / other webhook-driven APIs | $0 (webhook receive is free) |
| Background queue | $0 (pg_boss is Postgres-native) |
| AI-assisted features | ~$10/mo Claude API at moderate use |

Compared to Celigo entry tier (~$600/mo) or Mulesoft ($2K+/mo).

## What's NOT in v0.1

| Deferred | Why |
|---|---|
| Background worker / cron scheduler | Adds operational complexity; manual sync is enough to prove the pattern |
| Webhook receivers | Same — manual polling is enough for v0.1 |
| HTTP bridge to recon | Direct DB write works; refactor when there's a real reason (independent deployment, etc.) |
| Real auth integration | v0.1 trusts the dev box; would mirror ledger-core's stub when added |
| AI-assisted field mapping | Adds value but isn't load-bearing for v0.1 demo |
| Additional connectors | Build the pattern once; clone it when there's a real downstream consumer |
| Modified/removed transaction handling | Requires recon-side updates we haven't planned |
| Per-user channel preferences for sync notifications | Not started — notifications aren't even sent yet |

Most of these are scope-limited intentionally so v0.1 ships as a coherent, demonstrable unit. The connector pattern is the load-bearing artifact; everything else builds on top.
