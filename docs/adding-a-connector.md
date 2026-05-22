# Adding a new connector

The 5-step recipe, distilled from the Plaid implementation. Each step has a concrete pointer to the corresponding Plaid file so you can copy-adapt rather than write from scratch.

## Step 1 — types.ts

Define narrow TypeScript types for the records this connector deals with. Don't import the full SDK types — pull only what your mapper consumes. The full SDK types make IDE autocomplete heavy and surface details the rest of the engine doesn't need.

Also define the `Credentials` shape that's persisted to `Connection.credentialsJson`:

```typescript
// src/lib/connectors/<system>/types.ts

export interface MySystemCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  externalAccountId?: string;
}

export interface MySystemTransaction {
  id: string;
  amount: number;
  date: string;
  description: string;
  // ... only what mapper.ts uses
}
```

Reference: [`src/lib/connectors/plaid/types.ts`](../src/lib/connectors/plaid/types.ts)

## Step 2 — client.ts

Thin wrapper around the system's SDK. Centralizes:

- Configuration (env vars → SDK client instance)
- Test override (`setClientForTesting` hook so unit tests can inject a mock)
- The actual API operations the connector uses (one method per Plaid endpoint we hit)

Don't expose the SDK directly to the rest of the codebase. The wrapper is the contract; if the SDK changes, the rest of the code doesn't care.

Reference: [`src/lib/connectors/plaid/client.ts`](../src/lib/connectors/plaid/client.ts)

## Step 3 — mapper.ts

Pure function. Takes the connector's record type, returns the downstream-targeted shape (a `MappedBankLine` for bank-feed connectors; will be `MappedJournalEntry` for payroll connectors, etc.).

```typescript
// src/lib/connectors/<system>/mapper.ts

export const mySystemMapperV1: ConnectorMapper<MySystemTransaction, MappedBankLine> = {
  mapperVersion: "my-system-mapper-v1",
  map(raw: MySystemTransaction): MappedBankLine {
    return {
      externalId: raw.id,
      // ... transformation logic
    };
  },
};
```

Key disciplines:

- **No I/O.** No DB queries, no API calls, no env reads (except via injected config).
- **Document tricky transformations.** The Plaid mapper has a long comment about sign flipping because it's the most error-prone bit. Yours probably has its own gotchas — currency conversion? Timezone math? Document them inline.
- **Bump `mapperVersion` when logic changes.** Old staged records keep their `mapperVersion`; new records get the new one. Lets you re-map history selectively if needed.
- **Unit test exhaustively.** This is the layer that's easiest to test and most consequential when it breaks.

Reference: [`src/lib/connectors/plaid/mapper.ts`](../src/lib/connectors/plaid/mapper.ts) + [`tests/plaid-mapper.test.ts`](../tests/plaid-mapper.test.ts)

## Step 4 — connector.ts

Implements the `Connector<TRecord>` interface from [`src/lib/connectors/interface.ts`](../src/lib/connectors/interface.ts).

Required methods:

- `meta` — declares systemCode, displayName, targetType, capabilities flags
- `initiateAuth` — for OAuth: return `authUrl`; for Plaid-style embedded widgets: return `linkToken`
- `completeAuth` — exchange whatever the third-party returns for long-lived credentials. Returns `{ credentials, displayName, externalAccountId?, metadata? }`.
- `fetchSince` — `AsyncIterable<FetchPage<TRecord>>`. Stream pages of records since the cursor.

Optional methods (only if `meta.capabilities.X` is true):

- `pushRecord` — write a record back to the source system. Required if `capabilities.push`.
- `verifyWebhookSignature` — return boolean. Required if `capabilities.webhook`.
- `parseWebhookEvent` — convert webhook payload into the same `FetchPage` shape. Required if `capabilities.webhook`.
- `refreshAuth` — for systems with expiring tokens. Default behavior: no-op if not implemented.

Reference: [`src/lib/connectors/plaid/connector.ts`](../src/lib/connectors/plaid/connector.ts)

## Step 5 — register in the runner

Add the connector to `CONNECTOR_REGISTRY` in [`src/lib/sync/runner.ts`](../src/lib/sync/runner.ts):

```typescript
const CONNECTOR_REGISTRY: Record<string, Connector<any>> = {
  plaid: plaidConnector,
  my_system: mySystemConnector, // NEW
};
```

The runner dispatches by `Connection.systemCode`. That's the only place new connectors get plugged in — the engine itself doesn't change.

## If your target is NOT BANK_ACCOUNT

v0.1's only downstream target is recon's `BankStatementLine`. For a Stripe connector (payments → AR open items) or Gusto (payroll → JE via posting-rules), you'll need:

1. A new `ConnectionTargetType` enum value
2. A bridge module like [`src/lib/recon-bridge.ts`](../src/lib/recon-bridge.ts) — but writing to the appropriate downstream model
3. A new mapper output shape (the equivalent of `MappedBankLine`)
4. Update the sync runner's promotion call to dispatch by `targetType`

This is the v0.2+ scope. The runner today (`runConnectionSync`) hard-codes the BANK_ACCOUNT branch. When we add the second target, that becomes a switch.

## Tests

Two layers, both pure-function:

1. **Mapper tests** — exhaustive coverage of `map()`. Sign conventions, null fallbacks, edge cases. See [`tests/plaid-mapper.test.ts`](../tests/plaid-mapper.test.ts).
2. **Connector-interface conformance** — verifies the connector's `meta` declares the right capabilities and the required methods are present. Lightweight; the real interface enforcement is at the TypeScript compiler level (if your connector doesn't satisfy `Connector<T>`, tsc fails before tests run). See [`tests/connector-interface.test.ts`](../tests/connector-interface.test.ts).

Integration tests against the real connector's sandbox API are useful but not required for v0.1. Add them when the connector has a stable shape and you're refactoring.

## Smoke check

After all 5 steps, you should be able to:

1. `npx tsc --noEmit` — no errors
2. `npx vitest run` — all tests pass
3. Open the UI at `/connections/new`, the new system appears as an option (after you add it to the connect form's connector dropdown — currently hard-coded to Plaid; v0.2 will read from registry)
4. Click "Connect" — the connector's `initiateAuth` runs and returns a workable token / URL
5. Complete the auth flow — `completeAuth` runs, Connection row is created
6. Click "Sync now" — fetchSince streams records, mapper transforms, downstream bridge writes
7. Records appear in the downstream consumer's UI (e.g., recon's `/statements`)

Each step that fails points at the wrong layer to fix.
