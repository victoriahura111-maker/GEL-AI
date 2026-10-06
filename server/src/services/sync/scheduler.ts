import { config } from '../../config';
import { listConnectedUserIds } from '../notion/connectionRepository';
import { syncUser } from './engine';
import { checkSyncCooldown, recordSyncAttempt } from './cooldown';

/**
 * Phase 16 — periodic Notion synchronization scheduler.
 *
 * Wraps the per-user `syncUser` engine in a `setInterval` loop with an
 * **overlap guard** (a tick is skipped while the previous one is still running)
 * and `unref()` so the timer never keeps the process alive on its own.
 *
 * It is **disabled by default** (`SYNC_ENABLED=false`) and additionally requires
 * Supabase + Notion to be configured. It is armed **only** by `src/index.ts`, so
 * the loop is inert during tests. To enable periodic sync set:
 *
 * ```
 * SYNC_ENABLED=true        # arm the worker (default false)
 * SYNC_TICK_MS=900000      # every 15 minutes (default)
 * ```
 *
 * Each tick enumerates the users with a stored Notion connection (bounded),
 * honours the shared per-user cooldown, and reconciles each user independently
 * (`syncUser` never throws, and a failure on one user never aborts the tick).
 */

/** Upper bound on connected users reconciled per tick. */
export const DEFAULT_SYNC_USER_LIMIT = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** True while the interval loop is armed. */
export function isSyncSchedulerRunning(): boolean {
  return timer !== null;
}

/** Runs one guarded tick. Overlap protection skips a tick already in flight. */
async function runTick(userLimit: number): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const userIds = await listConnectedUserIds(userLimit);
    for (const userId of userIds) {
      if (!checkSyncCooldown(userId).allowed) continue;
      recordSyncAttempt(userId);
      try {
        await syncUser(userId, { direction: 'both' });
      } catch {
        // syncUser never throws, but isolate just in case.
        console.error('[sync] A per-user sync tick failed unexpectedly.');
      }
    }
  } catch {
    console.error('[sync] Could not enumerate users for a sync tick.');
  } finally {
    inFlight = false;
  }
}

/**
 * Arms the interval loop. Returns `false` (and does nothing) when Supabase/Notion
 * are unconfigured or `SYNC_ENABLED` is false.
 */
export function startSyncScheduler(
  options: { intervalMs?: number; userLimit?: number } = {}
): boolean {
  if (timer) return true;
  if (!config.isSupabaseConfigured || !config.isNotionConfigured || !config.syncEnabled) {
    return false;
  }

  const intervalMs = Math.max(options.intervalMs ?? config.syncTickMs, 1000);
  const userLimit = options.userLimit ?? DEFAULT_SYNC_USER_LIMIT;

  timer = setInterval(() => {
    void runTick(userLimit);
  }, intervalMs);
  // Do not keep the event loop alive purely for the scheduler.
  timer.unref?.();

  console.log(`[sync] scheduler started (every ${intervalMs}ms, cap ${userLimit} users/tick)`);
  return true;
}

/** Clears the interval loop (safe to call when not running). */
export function stopSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
