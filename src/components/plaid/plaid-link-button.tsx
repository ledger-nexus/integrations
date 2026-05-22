"use client";

// Client Component that wraps Plaid Link. Lifecycle:
//   1. Mount: call createLinkTokenAction to mint a link_token server-side
//   2. Pass the link_token to react-plaid-link's usePlaidLink hook
//   3. User clicks the button → Plaid Link opens an embedded widget
//   4. User completes bank login + selects an account
//   5. onSuccess fires with public_token + metadata
//   6. We call completePlaidLinkAction, which exchanges + creates Connection
//   7. Refresh the page so the new connection appears in the dashboard
//
// react-plaid-link's docs: https://github.com/plaid/react-plaid-link

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";
import { createLinkTokenAction } from "@/app/actions/create-link-token";
import { completePlaidLinkAction } from "@/app/actions/complete-plaid-link";

interface Props {
  /** recon BankAccount.id this Plaid feed will land in. */
  bankAccountId: string;
  /** Disable the button (e.g., while the form is incomplete). */
  disabled?: boolean;
}

export function PlaidLinkButton({ bankAccountId, disabled }: Props) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [completing, startCompletion] = useTransition();
  const [completionMessage, setCompletionMessage] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);

  // Mint a link_token on mount (or when the user clicks the button if
  // we haven't yet). Cached for the duration of the page session.
  useEffect(() => {
    if (linkToken || tokenError) return;
    createLinkTokenAction().then((res) => {
      if (res.ok && res.linkToken) {
        setLinkToken(res.linkToken);
      } else {
        setTokenError(res.message ?? "Failed to mint link token");
      }
    });
  }, [linkToken, tokenError]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => {
      // Plaid Link's metadata includes the user's selected account(s).
      // We take the first if multiple — multi-account flows are a
      // v0.2 enhancement.
      const selectedAccountId = metadata.accounts?.[0]?.id;
      startCompletion(async () => {
        const result = await completePlaidLinkAction({
          publicToken,
          selectedAccountId,
          bankAccountId,
          initialSync: true,
        });
        if (!result.ok) {
          setCompletionError(result.message ?? "Failed to complete Plaid Link");
          return;
        }
        setCompletionMessage(
          `Connected. Initial sync imported ${result.recordsAdded ?? 0} transactions.`
        );
        // Refresh the page so the new connection appears.
        router.refresh();
      });
    },
    onExit: (err) => {
      if (err) {
        setCompletionError(err.error_message ?? err.display_message ?? err.error_code);
      }
    },
  });

  const canClick = ready && !!linkToken && !completing && !disabled;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => open()}
        disabled={!canClick}
        className="inline-flex h-9 items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {!linkToken && !tokenError
          ? "Loading Plaid Link…"
          : completing
            ? "Finalizing connection…"
            : "Connect bank via Plaid"}
      </button>
      {tokenError && (
        <span className="text-xs text-negative">{tokenError}</span>
      )}
      {completionError && (
        <span className="text-xs text-negative">{completionError}</span>
      )}
      {completionMessage && (
        <span className="text-xs text-positive">{completionMessage}</span>
      )}
    </div>
  );
}
