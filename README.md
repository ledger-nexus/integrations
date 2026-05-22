# integrations

> AI-assisted data integration engine for the ledger-nexus portfolio. Pulls operational data from third-party SaaS systems (Plaid for banks, Stripe / Gusto / Bill.com later) and pushes it into the accounting substrate through the existing HTTP boundaries on ledger-core and recon.

Fourth repo in the [`ledger-nexus`](https://github.com/ledger-nexus) portfolio. Companion to [`ledger-core`](https://github.com/ledger-nexus/ledger-core), [`recon`](https://github.com/ledger-nexus/recon), and [`revenue-rec`](https://github.com/ledger-nexus/revenue-rec). Same shape: shared Postgres database, mirrors the substrate's models read-only, writes downstream via the established bridge pattern.

**The "Celigo-lite" framing.** Hand-coded TypeScript connectors instead of a JSON-config DSL. Pure mapper functions instead of a visual drag-drop builder. Cursor-based sync, idempotent at every layer, opt-in webhooks (v0.2+). Costs ~$50–100/mo at modest volume vs. Celigo's $600+ entry tier and Mulesoft's $2K+/mo.

---

## Architecture in one sentence

`integrations` runs a per-connection sync loop that calls each connector's `Connector<T>` interface, normalizes records through a pure mapper, stages them in `ImportStagingRecord`, and writes downstream — to recon's `BankStatementLine` in v0.1; via HTTP bridge to recon's internal endpoint in v0.2.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full pattern.

## What's wired (v0.1)

- ✅ **Connector interface** ([`src/lib/connectors/interface.ts`](src/lib/connectors/interface.ts)) — single TypeScript file defining `Connector<TRecord, TPush>`, `ConnectorMeta`, `ConnectorMapper`. Every connector implements this.
- ✅ **Plaid connector** ([`src/lib/connectors/plaid/`](src/lib/connectors/plaid/)) — types, client wrapper, mapper, connector. Polling via `/transactions/sync` (cursor-based; no missed / duplicate transactions). Sign-flip mapper (Plaid signs amounts opposite to recon) with exhaustive unit tests.
- ✅ **Sync runner** ([`src/lib/sync/runner.ts`](src/lib/sync/runner.ts)) — orchestrator: load Connection → call connector.fetchSince → stage records → run mapper → promote to recon. Single-connection lock; cursor advances only on success.
- ✅ **recon bridge** ([`src/lib/recon-bridge.ts`](src/lib/recon-bridge.ts)) — direct DB write to BankStatement + BankStatementLine. Idempotency via externalRef (Plaid `transaction_id`) dedup before insert.
- ✅ **Schema** — Connection, SyncRun, ImportStagingRecord (owned) + LegalEntity, Account, BankAccount, BankStatement, BankStatementLine (mirrored from recon).
- ✅ **UI** (port 3003): dashboard, connections list, connection detail, "Connect bank via Plaid" page with embedded Plaid Link widget.
- ✅ **Server Actions**: `createLinkTokenAction`, `completePlaidLinkAction`, `triggerSyncAction`.
- ✅ **32 unit tests** — Plaid mapper (sign flip both directions, currency fallback, description preference, null handling, realistic accounting scenarios) + connector-interface conformance.

## What lands next (v0.2 ideas)

- 🚧 **Webhook receivers** — Plaid TRANSACTIONS_UPDATES_AVAILABLE → immediate sync trigger
- 🚧 **Background scheduler** — pg_boss worker; nightly polling for each active connection
- 🚧 **HTTP bridge to recon** — replace direct DB write with `POST /api/internal/bank-lines` (symmetric with ledger-core's existing bridge)
- 🚧 **Additional connectors** — Stripe (payments → AR open item application), Gusto (payroll → JE via posting-rules), Bill.com (vendor invoices → AP open items)
- 🚧 **AI-assisted field mapping** — Claude proposes mappings when a new connector's schema doesn't fit an existing pattern
- 🚧 **Multi-account flows** — single Plaid Item → multiple Connection rows for checking + savings + credit card

## Quick start

```bash
# Prereqs: ledger-core + recon already running, shared DB seeded
git clone https://github.com/ledger-nexus/integrations.git
cd integrations
pnpm install
cp .env.example .env
# Set DATABASE_URL (same as ledger-core / recon)
# Get free Plaid sandbox credentials at https://dashboard.plaid.com/
# Set PLAID_CLIENT_ID + PLAID_SECRET in .env

pnpm db:push      # creates connection / sync_run / import_staging_record tables
pnpm dev          # http://localhost:3003 — note: different port than ledger-core (3000), recon (3001), revenue-rec (3002)
pnpm test         # 32 unit tests across mapper + connector-interface
```

Open `/connections/new`, pick a recon BankAccount, click "Connect bank via Plaid". In sandbox mode you can use Plaid's test credentials (`user_good` / `pass_good`) to simulate a real connection.

## Tech stack

Same as the other repos: Next.js 14 (App Router), Postgres + Prisma, decimal.js for money math, Vitest for tests, Tailwind for styling. New deps: `plaid` (official Node SDK), `react-plaid-link` (client-side Link widget).

## Project structure

```
integrations/
├── prisma/
│   └── schema.prisma                       # Connection, SyncRun, staging + recon mirror
├── src/
│   ├── app/                                # Next.js App Router (port 3003)
│   │   ├── layout.tsx, page.tsx (dashboard)
│   │   ├── connections/
│   │   │   ├── page.tsx                    # list + per-row "Sync now"
│   │   │   ├── new/
│   │   │   │   ├── page.tsx                # pick BankAccount + connect
│   │   │   │   └── connect-form.tsx        # client component
│   │   │   ├── [id]/page.tsx               # connection detail + sync history
│   │   │   └── trigger-sync-button.tsx     # client component
│   │   └── actions/
│   │       ├── create-link-token.ts        # mint Plaid link_token
│   │       ├── complete-plaid-link.ts      # exchange public→access, create Connection
│   │       └── trigger-sync.ts             # manual sync trigger
│   ├── components/
│   │   ├── ui/                             # Card, Button, Table, Badge, EmptyState
│   │   ├── nav/sidebar.tsx
│   │   └── plaid/plaid-link-button.tsx     # react-plaid-link wrapper
│   └── lib/
│       ├── db.ts                           # PrismaClient singleton
│       ├── connectors/
│       │   ├── interface.ts                # Connector<T> + ConnectorMapper<T,U>
│       │   └── plaid/
│       │       ├── types.ts
│       │       ├── client.ts               # Plaid SDK wrapper
│       │       ├── mapper.ts               # Plaid Txn → MappedBankLine (sign flip)
│       │       └── connector.ts            # implements Connector<PlaidTransaction>
│       ├── sync/runner.ts                  # orchestrator
│       ├── recon-bridge.ts                 # writes BankStatement + Lines (v0.1)
│       └── utils/
├── tests/
│   ├── plaid-mapper.test.ts                # 22 tests; sign flip, currency, dates, descriptions
│   └── connector-interface.test.ts         # 10 tests; meta + required-method conformance
└── docs/
    ├── ARCHITECTURE.md                     # cross-repo write story + design rationale
    └── adding-a-connector.md               # 5-step recipe for new integrations
```

## About this project

Part of **[ledger-nexus](https://github.com/ledger-nexus)** — a portfolio of accounting tools built by an accountant learning to ship software with AI:

| Repo | Role | Status |
|---|---|---|
| [`ledger-core`](https://github.com/ledger-nexus/ledger-core) | Universal accounting substrate + ownership engine | v1.10 ✅ |
| [`recon`](https://github.com/ledger-nexus/recon) | AI-assisted bank reconciliation | v0.2-beta ✅ |
| [`revenue-rec`](https://github.com/ledger-nexus/revenue-rec) | ASC 606 revenue recognition | v0.2 ✅ |
| `integrations` (this) | AI-assisted data integration engine | v0.1 in flight |

MIT licensed.
