"use client";

// Client Component for the "Sync now" button on each connection row.
// Calls triggerSyncAction; surfaces success/failure inline.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { triggerSyncAction } from "@/app/actions/trigger-sync";

export function TriggerSyncButton({ connectionId }: { connectionId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await triggerSyncAction(connectionId);
      if (!result.ok) {
        setError(result.message ?? "Sync failed");
      } else {
        setMessage(
          `Synced. Added ${result.recordsAdded ?? 0} record${
            result.recordsAdded === 1 ? "" : "s"
          }${
            result.recordsPromoted !== undefined
              ? `; promoted ${result.recordsPromoted} to recon.`
              : "."
          }`
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" variant="outline" onClick={onClick} disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
      </Button>
      {message && <span className="text-[10px] text-positive">{message}</span>}
      {error && <span className="text-[10px] text-negative">{error}</span>}
    </div>
  );
}
