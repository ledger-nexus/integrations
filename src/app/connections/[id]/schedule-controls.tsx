"use client";

// Interactive schedule controls on the connection detail page.
//
// States:
//   - Schedule off: shows "Enable schedule" form (preset dropdown +
//     custom-minutes input).
//   - Schedule on: shows current interval, next run time, "Pause"
//     button, and an "Edit interval" toggle that reveals the same
//     form pre-populated.
//
// All writes go through setConnectionScheduleAction; the server
// stamps the canonical nextSyncAt and we let revalidatePath bring
// the page state back. No optimistic UI — the cron tick depends on
// the persisted values, so showing them post-write is the source of
// truth.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { setConnectionScheduleAction } from "@/app/actions/set-connection-schedule";
import {
  SCHEDULER_PRESETS,
  SCHEDULER_MIN_INTERVAL_MINUTES,
  SCHEDULER_MAX_INTERVAL_MINUTES,
} from "@/lib/sync/scheduler";

interface Props {
  connectionId: string;
  scheduleEnabled: boolean;
  syncIntervalMinutes: number | null;
  nextSyncAt: string | null; // ISO; null = no schedule
  lastScheduledRunAt: string | null;
  nextRunDescription: string;
}

export function ScheduleControls({
  connectionId,
  scheduleEnabled,
  syncIntervalMinutes,
  nextSyncAt,
  lastScheduledRunAt,
  nextRunDescription,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intervalDraft, setIntervalDraft] = useState<number>(
    syncIntervalMinutes ?? 60
  );

  function onSave() {
    setError(null);
    startTransition(async () => {
      const result = await setConnectionScheduleAction({
        connectionId,
        enabled: true,
        intervalMinutes: intervalDraft,
      });
      if (!result.ok) {
        setError(result.message);
      } else {
        setEditing(false);
      }
    });
  }

  function onPause() {
    setError(null);
    startTransition(async () => {
      const result = await setConnectionScheduleAction({
        connectionId,
        enabled: false,
      });
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge tone={scheduleEnabled ? "positive" : "neutral"}>
              {scheduleEnabled ? "SCHEDULED" : "OFF"}
            </Badge>
            {scheduleEnabled && syncIntervalMinutes != null ? (
              <span className="text-xs text-ink-600">
                every {syncIntervalMinutes} minute{syncIntervalMinutes === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {scheduleEnabled ? (
            <div className="text-[11px] text-ink-500">
              Next run: <span className="text-ink-800">{nextRunDescription}</span>
              {nextSyncAt ? (
                <span className="text-ink-400"> · {formatIso(nextSyncAt)}</span>
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] text-ink-500">
              Manual + webhook only. Add a schedule to sync automatically.
            </div>
          )}
          {lastScheduledRunAt ? (
            <div className="text-[11px] text-ink-400">
              Cron last looked here at {formatIso(lastScheduledRunAt)}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          {scheduleEnabled ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing((v) => !v)}
                disabled={pending}
              >
                {editing ? "Cancel" : "Edit interval"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onPause} disabled={pending}>
                {pending ? "…" : "Pause"}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={pending}>
              Enable schedule
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 rounded-md border border-ink-200 bg-ink-50 p-3">
          <div className="text-[11px] text-ink-500">
            Min {SCHEDULER_MIN_INTERVAL_MINUTES} min · max {SCHEDULER_MAX_INTERVAL_MINUTES} min (24h).
            The cron tick runs every 5 min so shorter intervals don't make the
            schedule any faster.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SCHEDULER_PRESETS.map((p) => (
              <button
                key={p.minutes}
                type="button"
                onClick={() => setIntervalDraft(p.minutes)}
                disabled={pending}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  intervalDraft === p.minutes
                    ? "border-ink-700 bg-ink-900 text-white"
                    : "border-ink-200 bg-white text-ink-700 hover:bg-ink-100"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-ink-500" htmlFor="interval-minutes">
              Custom interval (minutes)
            </label>
            <input
              id="interval-minutes"
              type="number"
              min={SCHEDULER_MIN_INTERVAL_MINUTES}
              max={SCHEDULER_MAX_INTERVAL_MINUTES}
              value={intervalDraft}
              onChange={(e) => setIntervalDraft(parseInt(e.target.value, 10) || 0)}
              disabled={pending}
              className="h-8 w-20 rounded border border-ink-200 px-2 text-right text-xs tabular-nums"
            />
          </div>
          {error ? (
            <div className="rounded bg-rose-50 p-1.5 text-[11px] text-rose-800">
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={pending}>
              {pending ? "Saving…" : scheduleEnabled ? "Update" : "Enable"}
            </Button>
          </div>
        </div>
      ) : null}

      {!editing && error ? (
        <div className="rounded bg-rose-50 p-1.5 text-[11px] text-rose-800">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function formatIso(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
