// Exponential backoff math for repeated sync failures.
//
// When a connection fails N times in a row, polling it every
// `syncIntervalMinutes` becomes wasteful and rude:
//
//   - Plaid rate-limits per access token. A broken token returning
//     ITEM_LOGIN_REQUIRED every 5 minutes for 24h burns ~288 requests
//     against the limit before the operator notices.
//   - The recon bridge is HTTP — every attempt costs a round-trip.
//   - The operator's email inbox fills with "sync failed" alerts.
//
// Better: after each consecutive failure, increase the effective
// interval. Once the operator fixes the issue (re-link, etc.) and a
// sync succeeds, the counter resets and the schedule returns to its
// configured cadence.
//
// The cap (24h) means even a hopeless connection still tries once a
// day — if Plaid's outage resolves itself, we pick up automatically.
//
// Why doubling not linear: the gap between "transient flake" and
// "permanent break" spans orders of magnitude. After 6 consecutive
// failures, linear backoff would still try every 6× the base
// interval. Exponential gets to "tries once a day" by failure 8 for
// a 5-min base interval — that's the right shape.

import {
  SCHEDULER_MAX_INTERVAL_MINUTES,
  validateIntervalMinutes,
} from "./scheduler";

/** Maximum effective interval the backoff math will ever return. */
export const BACKOFF_MAX_MINUTES = SCHEDULER_MAX_INTERVAL_MINUTES; // 1440 (24h)

/**
 * Compute the effective interval for the NEXT scheduled attempt,
 * given the consecutive-failure count and the configured base
 * interval.
 *
 *   failures = 0  → base interval (the success path)
 *   failures = 1  → 2× base
 *   failures = 2  → 4× base
 *   failures = N  → 2^N × base, capped at BACKOFF_MAX_MINUTES (24h)
 *
 * The caller still validates the final interval is within the
 * scheduler's bounds (it always is — capped at the same ceiling).
 */
export function computeBackoffMinutes(input: {
  baseIntervalMinutes: number;
  consecutiveFailureCount: number;
}): number {
  const base = validateIntervalMinutes(input.baseIntervalMinutes);
  const failures = Math.max(0, Math.floor(input.consecutiveFailureCount));

  if (failures === 0) return base;

  // 2^failures via repeated doubling. We compute in plain integers
  // and short-circuit once we cross the cap; this also defends
  // against arithmetic overflow when the failure count gets large.
  let multiplier = 1;
  for (let i = 0; i < failures; i += 1) {
    multiplier *= 2;
    if (multiplier * base >= BACKOFF_MAX_MINUTES) {
      return BACKOFF_MAX_MINUTES;
    }
  }
  const effective = multiplier * base;
  return Math.min(effective, BACKOFF_MAX_MINUTES);
}

/**
 * Decide what `consecutiveFailureCount` becomes after a sync attempt
 * with the given outcome.
 *
 *   SUCCESS or PARTIAL_SUCCESS → reset to 0 (forward progress)
 *   FAILURE or ERROR → increment by 1
 *
 * PARTIAL_SUCCESS resets because the cursor advanced — we're not
 * stuck on a poisoned record; the next attempt won't replay the
 * failure.
 *
 * SKIPPED outcomes (locked, no-interval) leave the counter
 * untouched — we didn't actually try anything.
 */
export type AttemptOutcome =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "FAILURE"
  | "ERROR"
  | "SKIPPED";

export function nextFailureCount(input: {
  currentCount: number;
  outcome: AttemptOutcome;
}): number {
  if (input.outcome === "SUCCESS" || input.outcome === "PARTIAL_SUCCESS") return 0;
  if (input.outcome === "SKIPPED") return input.currentCount;
  // FAILURE / ERROR
  return Math.max(0, Math.floor(input.currentCount)) + 1;
}

/**
 * Human-readable description for the UI: "backoff active — 4× base"
 * vs "on schedule". Suppresses the multiplier when failures = 0.
 */
export function describeBackoffState(input: {
  baseIntervalMinutes: number;
  consecutiveFailureCount: number;
}): string {
  if (input.consecutiveFailureCount === 0) return "on schedule";
  const eff = computeBackoffMinutes(input);
  const multiplier = Math.round(eff / input.baseIntervalMinutes);
  if (eff >= BACKOFF_MAX_MINUTES) {
    return `backoff capped at 24h after ${input.consecutiveFailureCount} consecutive failure${input.consecutiveFailureCount === 1 ? "" : "s"}`;
  }
  return `backoff active — ${multiplier}× base interval after ${input.consecutiveFailureCount} consecutive failure${input.consecutiveFailureCount === 1 ? "" : "s"}`;
}
