"use client";

// Connect-form client component. Renders a list of recon BankAccount
// candidates as radio buttons + the PlaidLinkButton. The button is
// disabled until the user selects a target.

import { useState } from "react";
import { PlaidLinkButton } from "@/components/plaid/plaid-link-button";

export interface BankAccountChoice {
  id: string;
  code: string;
  displayName: string;
  bankName: string | null;
  last4: string | null;
  alreadyConnected: boolean;
}

interface Props {
  bankAccounts: BankAccountChoice[];
}

export function ConnectBankForm({ bankAccounts }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const eligible = bankAccounts.filter((b) => !b.alreadyConnected);

  return (
    <div className="flex flex-col gap-4">
      {eligible.length === 0 ? (
        <div className="text-sm text-ink-500">
          All bank accounts in recon are already connected to a Plaid feed.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {bankAccounts.map((b) => (
            <li
              key={b.id}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
                selectedId === b.id
                  ? "border-accent-500 bg-accent-50/30"
                  : "border-ink-200 bg-white"
              } ${b.alreadyConnected ? "opacity-50" : ""}`}
            >
              <input
                type="radio"
                name="bankAccountId"
                value={b.id}
                checked={selectedId === b.id}
                disabled={b.alreadyConnected}
                onChange={() => setSelectedId(b.id)}
                className="h-4 w-4"
              />
              <label className="flex-1 cursor-pointer text-sm">
                <div className="font-medium text-ink-900">{b.displayName}</div>
                <div className="text-[11px] text-ink-500">
                  <span className="font-mono">{b.code}</span>
                  {b.bankName ? ` · ${b.bankName}` : ""}
                  {b.last4 ? ` ****${b.last4}` : ""}
                </div>
              </label>
              {b.alreadyConnected && (
                <span className="text-[11px] font-medium text-ink-400">
                  already connected
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="pt-2">
        {selectedId ? (
          <PlaidLinkButton bankAccountId={selectedId} />
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-9 cursor-not-allowed items-center justify-center rounded-md bg-ink-300 px-4 text-sm font-medium text-white"
          >
            Pick a bank account above first
          </button>
        )}
      </div>
    </div>
  );
}
