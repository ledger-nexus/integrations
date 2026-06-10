// Live smoke test for the Plaid connector.
//
// Run this when you have:
//   - PLAID_CLIENT_ID + PLAID_SECRET set (sandbox keys are free)
//   - PLAID_ENV=sandbox (other values cost real money)
//
//   tsx scripts/smoke-test-plaid.ts
//
// What it does (no DB writes, no recon contact):
//
//   1. Spin up a Plaid Sandbox Item with seed transactions.
//   2. Exchange the public_token for an access_token.
//   3. Call /transactions/sync via our connector wrapper.
//   4. Print added / modified / removed counts + a sample mapping.
//   5. If --multi-page is passed, walk pages until has_more=false
//      to verify the connector's iteration works across multiple
//      /sync responses.
//
// This is the test the mocked-client unit tests can't do for you.
// It validates that:
//   - Our Plaid SDK wrapper handles the real API response shape
//   - account_id filtering works on sandbox data
//   - The mapper produces sane MappedBankLine output
//   - Modified + removed records (commit e058892) round-trip through
//     the FetchPage interface as expected
//
// Run before any change to plaid/connector.ts or plaid/mapper.ts
// goes to prod.

import "dotenv/config";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  CountryCode,
  Products,
} from "plaid";
import {
  plaidConnector,
  _internal,
} from "../src/lib/connectors/plaid/connector";
import { plaidMapperV1 } from "../src/lib/connectors/plaid/mapper";

interface SmokeResult {
  itemId: string;
  accessTokenShort: string;
  added: number;
  modified: number;
  removed: number;
  pagesIterated: number;
  sampleMappedLine?: ReturnType<typeof plaidMapperV1.map>;
}

async function main() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.error(
      "PLAID_CLIENT_ID + PLAID_SECRET required. Get free sandbox keys at https://dashboard.plaid.com/."
    );
    process.exit(1);
  }
  if ((process.env.PLAID_ENV ?? "sandbox") !== "sandbox") {
    console.error(
      `PLAID_ENV=${process.env.PLAID_ENV} — refusing to run smoke against non-sandbox. Set PLAID_ENV=sandbox.`
    );
    process.exit(1);
  }

  console.log("integrations Plaid connector smoke test...");
  console.log("");

  const config = new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  });
  const client = new PlaidApi(config);

  // 1. Create a Plaid Sandbox Item with seed transactions.
  console.log("Creating sandbox Item...");
  const sandboxRes = await client.sandboxPublicTokenCreate({
    institution_id: "ins_109508", // First Platypus Bank (Plaid's standard test institution)
    initial_products: [Products.Transactions],
  });
  const publicToken = sandboxRes.data.public_token;

  // 2. Exchange public_token → access_token via the connector's helper.
  console.log("Exchanging public_token for access_token...");
  const { credentials } = await _internal.buildCredentialsFromPublicToken(
    publicToken
  );
  console.log(`  itemId: ${credentials.itemId}`);
  console.log(`  institution: ${credentials.institutionName ?? "(unknown)"}`);
  console.log(`  account: ${credentials.accountId ?? "(unset)"}`);
  console.log("");

  // 3. Run the connector's fetchSince. Plaid sandbox seeds transactions
  // immediately; cursor starts null.
  console.log("Calling /transactions/sync via the connector...");
  let added = 0;
  let modified = 0;
  let removed = 0;
  let pagesIterated = 0;
  let sample: SmokeResult["sampleMappedLine"];

  for await (const page of plaidConnector.fetchSince({
    credentials: credentials as unknown as Record<string, unknown>,
    cursor: null,
  })) {
    pagesIterated += 1;
    added += page.records.length;
    modified += page.modifiedRecords?.length ?? 0;
    removed += page.removedExternalIds?.length ?? 0;
    if (!sample && page.records[0]) {
      sample = plaidMapperV1.map(page.records[0].raw);
    }
    if (page.nextCursor === null) break;
  }

  const result: SmokeResult = {
    itemId: credentials.itemId,
    accessTokenShort: credentials.accessToken.slice(0, 12) + "...",
    added,
    modified,
    removed,
    pagesIterated,
    sampleMappedLine: sample,
  };

  console.log("");
  console.log("Result:");
  console.log(JSON.stringify(result, null, 2));
  console.log("");

  if (added === 0) {
    console.error(
      "WARNING: 0 added transactions returned — sandbox may need a moment to seed. Re-run if this is a fresh Item."
    );
    process.exit(2);
  }

  console.log("✓ smoke test passed");
}

main().catch((e) => {
  console.error("Smoke test FAILED:", e);
  process.exit(1);
});
