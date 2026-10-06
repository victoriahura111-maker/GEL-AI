import { config } from '../../config';

/**
 * Phase 16 — per-user manual-sync cooldown.
 *
 * `POST /api/sync` is user-triggered, so a stuck client (or an impatient user)
 * could hammer the Notion API. The controller consults this in-process map
 * before running a sync and records an attempt afterwards; a sync started within
 * `SYNC_MIN_INTERVAL_MS` of the previous one is rejected with `429`.
 *
 * The state is process-local (best-effort, like the OAuth nonce store): in a
 * multi-instance deployment each replica tracks its own cooldown. That is
 * acceptable here because the cooldown is a politeness guard, not a security
 * control.
 */

const lastAttemptAt = new Map<string, number>();

export interface CooldownDecision {
  allowed: boolean;
  /** Milliseconds until another sync is permitted (0 when allowed). */
  retryAfterMs: number;
}

/** Returns whether a sync is permitted for `userId` right now. */
export function checkSyncCooldown(userId: string, now: number = Date.now()): CooldownDecision {
  const previous = lastAttemptAt.get(userId);
  if (previous === undefined) return { allowed: true, retryAfterMs: 0 };

  const minInterval = config.syncMinIntervalMs;
  const elapsed = now - previous;
  if (elapsed >= minInterval) return { allowed: true, retryAfterMs: 0 };

  return { allowed: false, retryAfterMs: minInterval - elapsed };
}

/** Records that a sync attempt for `userId` started now. */
export function recordSyncAttempt(userId: string, now: number = Date.now()): void {
  lastAttemptAt.set(userId, now);
}

/** Clears the cooldown for one user, or for everyone when called with no id. */
export function resetSyncCooldown(userId?: string): void {
  if (userId === undefined) {
    lastAttemptAt.clear();
    return;
  }
  lastAttemptAt.delete(userId);
}
