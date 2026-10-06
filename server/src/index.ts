import { createApp } from './app';
import { config } from './config';
import { startReminderScheduler, stopReminderScheduler } from './services/reminders';
import { startFollowUpScheduler, stopFollowUpScheduler } from './services/followup';
import { startSyncScheduler, stopSyncScheduler } from './services/sync';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[server] listening on ${config.apiUrl} (port ${config.port}, env ${config.env})`);

  // Phase 13 — start the reminder worker. `startReminderScheduler` is a no-op
  // (returns false) when Supabase is unconfigured or REMINDERS_ENABLED is false,
  // so tests and misconfigured local boots never arm a timer.
  const remindersStarted = startReminderScheduler();
  if (!remindersStarted) {
    console.log('[server] reminder scheduler not started (Supabase unconfigured or disabled)');
  }

  // Phase 15 — start the follow-up worker under the same rule set
  // (FOLLOW_UP_ENABLED instead of REMINDERS_ENABLED).
  const followUpsStarted = startFollowUpScheduler();
  if (!followUpsStarted) {
    console.log('[server] follow-up scheduler not started (Supabase unconfigured or disabled)');
  }

  // Phase 16 — start the periodic Notion sync worker. Disabled by default
  // (SYNC_ENABLED=false) and requires Supabase + Notion to be configured.
  const syncStarted = startSyncScheduler();
  if (!syncStarted) {
    console.log('[server] sync scheduler not started (disabled or not configured)');
  }
});

let shuttingDown = false;

/** Maximum time to wait for in-flight requests before forcing exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Phase 19 — graceful shutdown. Stops every background scheduler first (so no
 * new work is started), then stops accepting new connections and waits for
 * in-flight requests to drain. A hard timeout guarantees the process still exits
 * if a keep-alive connection never closes, so an orchestrator's SIGTERM never
 * hangs. Repeated signals are ignored while a shutdown is already in progress.
 */
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[server] ${signal} received, shutting down gracefully`);

  // Stop background workers before closing the HTTP server so no tick starts
  // new work mid-shutdown.
  stopReminderScheduler();
  stopFollowUpScheduler();
  stopSyncScheduler();

  const forceExit = setTimeout(() => {
    console.warn(`[server] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not let the timer itself keep the event loop alive.
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    console.log('[server] HTTP server closed, shutting down');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
