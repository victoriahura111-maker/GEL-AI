import { config } from '../../config';
import { processFollowUps, DEFAULT_FOLLOW_UP_TICK_LIMIT } from './engine';

/**
 * Phase 15 — follow-up scheduler lifecycle.
 *
 * Wraps `processFollowUps` in a `setInterval` loop with an **overlap guard**
 * (a tick is skipped while the previous one is still in flight) and `unref()` so
 * the timer never keeps the process alive on its own. It is armed **only** by
 * `src/index.ts` and only when Supabase is configured and `FOLLOW_UP_ENABLED` is
 * true, so the loop is inert during tests and misconfigured local boots.
 */

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** True while the interval loop is armed. */
export function isFollowUpSchedulerRunning(): boolean {
  return timer !== null;
}

/** Runs one guarded tick. Overlap protection skips a tick already in flight. */
async function runTick(limit: number): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await processFollowUps(new Date(), limit);
  } catch {
    // `processFollowUps` never throws; this is a last-resort guard so an
    // unhandled rejection can never crash the process.
    console.error('[followup] Tick failed unexpectedly.');
  } finally {
    inFlight = false;
  }
}

/**
 * Arms the interval loop. Returns `false` (and does nothing) when Supabase is
 * unconfigured or `FOLLOW_UP_ENABLED` is false.
 */
export function startFollowUpScheduler(
  options: { intervalMs?: number; limit?: number } = {}
): boolean {
  if (timer) return true;
  if (!config.isSupabaseConfigured || !config.followUpEnabled) return false;

  const intervalMs = Math.max(options.intervalMs ?? config.followUpTickMs, 1000);
  const limit = options.limit ?? DEFAULT_FOLLOW_UP_TICK_LIMIT;

  timer = setInterval(() => {
    void runTick(limit);
  }, intervalMs);
  // Do not keep the event loop alive purely for the scheduler.
  timer.unref?.();

  console.log(`[followup] scheduler started (every ${intervalMs}ms, cap ${limit}/tick)`);
  return true;
}

/** Clears the interval loop (safe to call when not running). */
export function stopFollowUpScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
