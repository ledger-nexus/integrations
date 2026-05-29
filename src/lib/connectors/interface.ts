// The Connector interface — the keystone of the integration engine.
//
// Every third-party system (Plaid, Stripe, Gusto, Bill.com, ...) is
// integrated by implementing this single interface. The engine then
// uses the interface generically: auth flow, polling sync, webhook
// receive, optional push-back. Each connector is a self-contained module
// at src/lib/connectors/<system>/.
//
// Why this shape (vs. n8n nodes, JSON config, Airbyte schemas):
//
//   - Hand-coded TypeScript modules. Type-safe end to end. The mapper
//     from <external record> to <ledger record> is a real function with
//     explicit types, not a JSON expression language. This forces the
//     authoring discipline (think it through in code) that prevents the
//     "infinitely configurable but actually broken" failure mode of
//     low-code platforms.
//   - One interface for all sync directions: pull (fetch), push (write
//     back, optional), and webhook (parse inbound events).
//   - Streaming via AsyncIterable so memory usage stays bounded — the
//     engine pages through transactions without loading them all at once.
//   - Cursor + credentials are explicit parameters; the connector never
//     reads the DB directly. The engine handles persistence; the
//     connector handles the wire protocol.

/**
 * What a connector knows about itself. Pure data — no behavior.
 */
export interface ConnectorMeta {
  /** Stable identifier. Used as a discriminator in Connection.systemCode. */
  systemCode: string;
  /** Human-readable name shown in the UI. */
  displayName: string;
  /** What downstream surface this connector feeds. */
  targetType: "BANK_ACCOUNT"; // v0.1; v0.2+ adds PARTY, GL_ACCOUNT, VENDOR, EMPLOYEE
  /** Capability flags. Engine uses these to know which optional methods exist. */
  capabilities: {
    polling: boolean;
    webhook: boolean;
    push: boolean;
  };
}

/**
 * Opaque credentials blob. Shape is connector-defined. The engine treats
 * it as a black box — only the connector knows what's inside. Persisted
 * to Connection.credentialsJson.
 */
export type ConnectorCredentials = Record<string, unknown>;

/**
 * Auth flow — initiate phase. Returns a URL the user is redirected to
 * (or, for Plaid-style flows, a link_token the client SDK uses to open
 * an embedded widget).
 */
export interface InitiateAuthInput {
  /** Where the third-party should redirect back after auth. */
  redirectUri: string;
  /** User initiating the connection — useful for OAuth state binding. */
  actorUserId: string;
}

export interface InitiateAuthResult {
  /** For OAuth-redirect flows: the URL to send the user to. */
  authUrl?: string;
  /** For embedded-widget flows (Plaid Link): the token the client SDK opens with. */
  linkToken?: string;
  /** Connector-specific state to round-trip back to completeAuth. */
  authState?: Record<string, unknown>;
}

/**
 * Auth flow — complete phase. Called when the third-party returns
 * control to us with whatever it returns (OAuth code, Plaid public_token,
 * etc.). Returns the credentials we'll persist.
 */
export interface CompleteAuthInput {
  /** Connector-specific callback params (query string for OAuth, body for Plaid). */
  callbackParams: Record<string, unknown>;
  /** State from InitiateAuthResult.authState, round-tripped. */
  authState?: Record<string, unknown>;
}

export interface CompleteAuthResult {
  credentials: ConnectorCredentials;
  /** Display name for the new Connection (e.g., "Chase Operating ****1234"). */
  displayName: string;
  /**
   * If the connector identifies a specific external account/entity
   * (a bank account, a Stripe account), surface its external id so
   * the engine can dedupe or auto-link to a downstream target.
   */
  externalAccountId?: string;
  /** Extra metadata the connector wants to remember (institution name, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * A page of records returned by fetchSince. Streaming-friendly via
 * AsyncIterable. The connector yields one page at a time; the engine
 * processes each page before pulling the next.
 *
 * Each record carries the connector's external id (for idempotency)
 * plus the raw payload (for the staging table's frozen audit trail).
 */
export interface FetchPage<TRecord> {
  /** ADDED records — new transactions/rows on this page. */
  records: Array<{
    externalId: string;
    raw: TRecord;
  }>;
  /**
   * MODIFIED records — existing transactions the source system has
   * retroactively corrected (amount fix, description change,
   * date reclassification). Same shape as `records`; downstream
   * consumers replace the prior values for the same externalId.
   *
   * Optional. Connectors that don't support modifications (or whose
   * sync APIs don't surface them) omit this field entirely; the
   * engine treats undefined the same as an empty array.
   */
  modifiedRecords?: Array<{
    externalId: string;
    raw: TRecord;
  }>;
  /**
   * REMOVED records — source system says these transactions no
   * longer exist (cancelled, voided, deleted). Only the externalId
   * is provided; the engine matches against previously-staged
   * records to find what to void downstream.
   *
   * Optional. Same default semantics as `modifiedRecords`.
   */
  removedExternalIds?: string[];
  /** Cursor to pass on the next call. null = no more pages. */
  nextCursor: string | null;
}

/**
 * Pull phase — fetch records since the last cursor. The engine calls
 * this with the cursor from the previous successful sync. The connector
 * yields pages until exhausted (or hits its own internal page cap).
 */
export interface FetchSinceInput {
  credentials: ConnectorCredentials;
  cursor: string | null;
}

/**
 * Push phase (optional). For connectors that support pushing data back
 * to the source system. Out of scope for v0.1; signature is here so the
 * pattern is consistent.
 */
export interface PushInput<TPush> {
  credentials: ConnectorCredentials;
  record: TPush;
}

export interface PushResult {
  externalId: string;
  raw: unknown;
}

/**
 * Webhook (optional). Two-phase: verify the signature, then parse the
 * event into the same shape as fetchSince records. The engine handles
 * the route plumbing; the connector handles the wire format.
 */
export interface VerifyWebhookInput {
  /** Raw body bytes as a string. Critical: must be the bytes as received, NOT a re-stringification of JSON.parse(body). */
  rawBody: string;
  /** Lowercased header map. Route handlers normalize before calling. */
  headers: Record<string, string | undefined>;
  credentials?: ConnectorCredentials;
}

/**
 * Result of webhook signature verification. We surface the failure
 * reason so the route handler can audit-log it without having the
 * verifier re-do that work.
 */
export type VerifyWebhookResult =
  | { ok: true; kid?: string }
  | { ok: false; reason: string };

export interface ParseWebhookInput<TRecord> {
  body: unknown;
  credentials?: ConnectorCredentials;
}

export interface ParseWebhookResult<TRecord> {
  records: Array<{
    externalId: string;
    raw: TRecord;
  }>;
  /**
   * If the webhook is a notification ("new transactions available") rather
   * than the records themselves, the connector may set
   * needsImmediateFetch=true and the engine will trigger a pull.
   * Plaid's transactions webhook works this way.
   */
  needsImmediateFetch?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Connector interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The generic Connector interface. TRecord is the connector's native
 * record shape (Plaid's Transaction, Stripe's Charge, etc.). TPush is
 * the shape for push-back (often a subset of TRecord).
 */
export interface Connector<TRecord, TPush = never> {
  meta: ConnectorMeta;

  // ─── Auth (required) ────────────────────────────────────────────────────
  initiateAuth(input: InitiateAuthInput): Promise<InitiateAuthResult>;
  completeAuth(input: CompleteAuthInput): Promise<CompleteAuthResult>;
  /** Refresh long-lived tokens. Default impl: no-op if not provided. */
  refreshAuth?(credentials: ConnectorCredentials): Promise<ConnectorCredentials>;

  // ─── Pull (required if capabilities.polling) ────────────────────────────
  /**
   * Stream pages of records since the cursor. AsyncIterable so the engine
   * can process pages incrementally — no need to hold a whole 10K-row
   * sync in memory.
   */
  fetchSince(input: FetchSinceInput): AsyncIterable<FetchPage<TRecord>>;

  // ─── Push (optional; required if capabilities.push) ─────────────────────
  pushRecord?(input: PushInput<TPush>): Promise<PushResult>;

  // ─── Webhook (optional; required if capabilities.webhook) ───────────────
  /**
   * Authenticate an inbound webhook. For HMAC-shaped signatures this can
   * return synchronously; for JWT-shaped (Plaid, Stripe meter events
   * inbound, etc.) it returns a Promise because the public key fetch is
   * async + cached out-of-band. Returning a result object instead of a
   * bare boolean lets the route handler audit-log the failure reason.
   */
  verifyWebhookSignature?(
    input: VerifyWebhookInput
  ): VerifyWebhookResult | Promise<VerifyWebhookResult>;
  parseWebhookEvent?(input: ParseWebhookInput<TRecord>): Promise<ParseWebhookResult<TRecord>>;
}

/**
 * Connector mapper. Pure function that converts a connector record into
 * the shape the downstream system expects. Lives alongside the connector
 * in <system>/mapper.ts. Kept separate from the connector itself so the
 * mapping logic can be unit-tested without any I/O.
 */
export interface ConnectorMapper<TRecord, TMapped> {
  /** Stable identifier; logged + audited so we can re-map historical staging records when mapping logic evolves. */
  mapperVersion: string;
  map(raw: TRecord): TMapped;
}
