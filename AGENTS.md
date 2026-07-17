# AGENTS.md — integrations

Instructions for AI coding/review agents (Codex, etc.). The **reviewer's contract**: what to check, what is *intentional and must NOT be flagged*. Canonical: [`CLAUDE.md`](CLAUDE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md).

## What this is

`integrations` is the data-integration engine in the `ledger-nexus` portfolio — hand-coded, accounting-aware connectors (Plaid first) that pull third-party SaaS data and push it into the substrate through the existing HTTP boundaries on ledger-core and recon.

## Review THESE first — this repo handles third-party secrets

- **A leaked OAuth `accessToken` in Sentry is a CRITICAL incident** (attacker gets bank/Stripe/Gusto access). All error emission goes through `src/lib/monitoring/index.ts` (`redactPii` first); **never call Sentry directly, never `console.error` a Plaid/Stripe/vendor error's `.message`** — vendor errors routinely embed the raw access token and transaction descriptions. New vendor identifier → add it to `src/lib/soc2/redact-pii.ts` (`plaidItemId`, `stripeCustomerId`, `linkToken`, etc.). A raw `.message`/`.stack` reaching Sentry is the top-severity defect class here.
- **Cursor advances ONLY on a successful sync.** A failed sync must leave the cursor untouched so the next attempt re-pulls the same window. A code path that advances the cursor before confirming success is a real data-loss bug.
- **Idempotency via `externalRef`** (e.g. Plaid `transaction_id`) — overlapping sync windows must dedup before insert. Missing dedup is a defect.
- **Webhook receivers** must verify signatures before trusting the payload; OAuth flows and webhook receivers are the highest-risk surfaces — review them hardest.

## Intentional — do NOT report these as defects

- **The `prisma/schema.prisma` mirrors of ledger-core-owned and recon-owned tables are GENERATED, not accidental duplication.** Don't suggest importing them or de-duplicating.
- **`prisma db push` is BANNED.** integrations-owned schema changes use the reviewed-diff protocol. Don't recommend `db push` / `migrate dev`.
- **Connectors are hand-coded TypeScript modules implementing `Connector<T>` — there is deliberately NO JSON-config DSL, NO drag-and-drop / visual flow builder.** "You should make this config-driven / build a generic flow engine" is explicitly rejected architecture (Zapier/Make/n8n do that; the value here is deep, typed, accounting-aware connectors). Do not propose it.
- **Connector mappers (`(raw) => mapped`) do no I/O, no DB access** — pure, unit-tested in isolation, with a stamped mapper version. Don't suggest folding DB writes into a mapper.
- **Per-event handlers in code, not a flow engine** — deliberate.

## Security lens (SOC 2)

Portfolio baseline, with token confidentiality as the headline control. The integrations port pins a Critical-tier test that a `"Plaid sync failed for token plk-secret-…"` message cannot reach Sentry's index via the sanitized stack — treat any regression to that as top severity.
