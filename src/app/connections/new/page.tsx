// Connect a new bank via Plaid.
//
// The user picks which recon BankAccount this Plaid feed should land
// in (since recon's BankAccount rows are pre-seeded by ledger-core /
// recon), then clicks "Connect bank via Plaid" which opens Plaid Link.
// onSuccess → completePlaidLinkAction → Connection row created + initial sync.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ConnectBankForm } from "./connect-form";

export default async function ConnectNewBankPage() {
  // Available targets — recon BankAccount rows the user can route this
  // Plaid feed into. v0.1 doesn't auto-create new BankAccounts (would
  // require ledger-core chart-of-accounts coordination); user must pick
  // one that exists.
  const bankAccounts = await prisma.bankAccount.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      displayName: true,
      bankName: true,
      accountNumberLast4: true,
    },
    orderBy: { code: "asc" },
  });

  // Already-connected accounts — show but mark them as "already connected."
  const existingConnections = await prisma.connection.findMany({
    where: { systemCode: "plaid", status: "ACTIVE" },
    select: { targetId: true },
  });
  const connectedIds = new Set(
    existingConnections.map((c) => c.targetId).filter((x): x is string => !!x)
  );

  const plaidConfigured =
    !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/connections"
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          ← All connections
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">Connect a bank via Plaid</h2>
        <p className="text-sm text-ink-500">
          Plaid handles the bank login + MFA + token management. We never
          see the user's banking credentials.
        </p>
      </div>

      {!plaidConfigured && (
        <Card>
          <CardContent className="bg-amber-50 px-5 py-4">
            <div className="text-sm font-medium text-amber-900">
              Plaid credentials not configured
            </div>
            <p className="mt-1 text-xs text-amber-800">
              Set <code className="font-mono">PLAID_CLIENT_ID</code> and{" "}
              <code className="font-mono">PLAID_SECRET</code> in{" "}
              <code className="font-mono">.env</code>. Sandbox keys are
              free at{" "}
              <a
                href="https://dashboard.plaid.com/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                dashboard.plaid.com
              </a>
              . The Connect button below will fail until both are set.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pick the recon BankAccount this feed lands in</CardTitle>
          <span className="text-xs text-ink-500">
            recon's BankAccount is the "physical" target — your Chase Operating
            account, Bank of America savings, etc. Already-connected accounts
            are excluded.
          </span>
        </CardHeader>
        <CardContent>
          {bankAccounts.length === 0 ? (
            <EmptyState
              title="No bank accounts in recon yet"
              description="Seed recon (pnpm db:seed in the recon repo) so there's a BankAccount to feed."
            />
          ) : (
            <ConnectBankForm
              bankAccounts={bankAccounts.map((b) => ({
                id: b.id,
                code: b.code,
                displayName: b.displayName,
                bankName: b.bankName,
                last4: b.accountNumberLast4,
                alreadyConnected: connectedIds.has(b.id),
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
