import { config } from '../../config';
import { writeAuditLog } from '../audit/auditLog';
import { getNotificationService } from '../notifications';
import type { NotificationPayload } from '../notifications';
import { getTaskById } from '../tasks/repository';
import type { TaskRecord } from '../tasks/repository';
import {
  claimReminder,
  createReminder,
  listDueReminders,
  markReminderFailed,
  markReminderSent,
} from './repository';
import type { ReminderRecord } from './repository';
import { advanceRecurrence } from './schedule';

/**
 * Phase 13 — reminder engine.
 *
 * `processDueReminders` is the **testable core**: a single, throw-free tick that
 * claims each due reminder, delivers it through the notification service, and
 * records the outcome. `startReminderScheduler`/`stopReminderScheduler` wrap it in
 * an interval; they are only ever started by `src/index.ts` (the server
 * bootstrap), so the loop stays inert during tests.
 *
 * ## Idempotency
 *
 * Claiming (`pending → sent`, atomic + conditional) guarantees only one tick ever
 * delivers a given reminder. A reminder already claimed elsewhere yields `null`
 * and is counted as `skipped`.
 *
 * ## Failure isolation
 *
 * A failure on one reminder (missing task, dispatch error, repo error) marks that
 * reminder `failed` with a reason and never aborts the tick. The list query
 * itself is guarded too: if it throws, the tick returns an empty result.
 *
 * ## Recurrence
 *
 * After a successful send, a reminder carrying `recurrence` (`daily`/`weekly`)
 * arms the **next** occurrence as a fresh `pending` row (history is preserved).
 * A missing, completed, or cancelled task stops recurrence because the reminder
 * is failed before any send.
 */

/** Aggregate outcome of one tick. */
export interface ReminderTickResult {
  /** Due reminders considered this tick. */
  processed: number;
  /** Reminders delivered and marked `sent`. */
  sent: number;
  /** Reminders marked `failed` (missing task, closed task, dispatch error). */
  failed: number;
  /** Reminders already claimed by another tick (idempotency). */
  skipped: number;
  /** Next occurrences created for recurring reminders. */
  recurrencesScheduled: number;
}

/** Hard per-tick cap so a large backlog cannot monopolise the loop. */
export const DEFAULT_TICK_LIMIT = 50;

function toDate(now: Date | string | undefined): Date {
  if (now instanceof Date) return now;
  if (typeof now === 'string') {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Human deadline text ("2026-10-06 at 17:00", "2026-10-06", or "soon"). */
function deadlineText(task: TaskRecord): string {
  if (!task.due_date) return 'soon';
  return task.due_time ? `${task.due_date} at ${task.due_time}` : task.due_date;
}

/** Builds the channel-agnostic notification for a due reminder. */
export function buildReminderNotification(
  reminder: ReminderRecord,
  task: TaskRecord
): NotificationPayload {
  const title = `Reminder: ${task.title}`;
  const body = `Your task "${task.title}" is due ${deadlineText(task)}.`;

  return {
    userId: reminder.user_id,
    title,
    body,
    type: 'reminder',
    taskId: task.id,
    notionUrl: task.notion_url,
    metadata: {
      reminderId: reminder.id,
      channel: reminder.channel,
      scheduledFor: reminder.scheduled_for,
    },
  };
}

/** Best-effort audit write; never throws. */
async function audit(
  action: 'reminder_sent' | 'reminder_failed',
  reminder: ReminderRecord,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await writeAuditLog(reminder.user_id, {
      action,
      taskId: reminder.task_id,
      notionPageId: null,
      toolName: 'reminder_engine',
      metadata,
    });
  } catch {
    console.error('[reminders] Could not write a reminder audit row.');
  }
}

/** Marks a claimed reminder failed (best-effort) and records the audit row. */
async function failReminder(reminder: ReminderRecord, reason: string): Promise<void> {
  try {
    await markReminderFailed(reminder.id, reason);
  } catch {
    console.error('[reminders] Could not mark a reminder as failed.');
  }
  await audit('reminder_failed', reminder, { reason, channel: reminder.channel });
}

/** Processes one claimed reminder. Never throws. */
async function processOne(
  reminder: ReminderRecord,
  now: Date,
  nowIso: string,
  result: ReminderTickResult
): Promise<void> {
  // (1) Claim atomically. A null result means another tick already handled it.
  let claimed: ReminderRecord | null = null;
  try {
    claimed = await claimReminder(reminder.id);
  } catch {
    result.failed += 1;
    await failReminder(reminder, 'Could not claim the reminder.');
    return;
  }

  if (!claimed) {
    result.skipped += 1;
    return;
  }

  // (2) Load the task. A missing/deleted task fails the reminder.
  let task: TaskRecord | null = null;
  try {
    task = await getTaskById(claimed.user_id, claimed.task_id);
  } catch {
    task = null;
  }

  if (!task) {
    result.failed += 1;
    await failReminder(claimed, 'The related task was not found.');
    return;
  }

  // (3) A closed task stops delivery *and* recurrence.
  if (task.status === 'completed' || task.status === 'cancelled') {
    result.failed += 1;
    await failReminder(claimed, `The related task is ${task.status}.`);
    return;
  }

  // (4) Dispatch. Any rejection marks the reminder failed with the message.
  try {
    const service = getNotificationService(claimed.channel);
    await service.send(buildReminderNotification(claimed, task));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Notification delivery failed.';
    result.failed += 1;
    await failReminder(claimed, reason);
    return;
  }

  // (5) Success.
  try {
    await markReminderSent(claimed.id, nowIso);
  } catch {
    console.error('[reminders] Could not record sent_at for a delivered reminder.');
  }
  await audit('reminder_sent', claimed, {
    channel: claimed.channel,
    scheduledFor: claimed.scheduled_for,
    recurrence: claimed.recurrence,
  });
  result.sent += 1;

  // (6) Arm the next occurrence for a recurring reminder.
  if (claimed.recurrence) {
    const nextIso = advanceRecurrence(claimed.scheduled_for, claimed.recurrence, now);
    if (nextIso) {
      try {
        await createReminder(claimed.user_id, {
          taskId: claimed.task_id,
          scheduledFor: nextIso,
          timezone: claimed.timezone,
          channel: claimed.channel,
          recurrence: claimed.recurrence,
        });
        result.recurrencesScheduled += 1;
      } catch {
        console.error('[reminders] Could not arm the next recurring reminder.');
      }
    }
  }
}

/**
 * Runs one reminder tick: fetch due reminders, deliver each, record outcomes.
 * Never throws — a failure anywhere is isolated and reflected in the result.
 */
export async function processDueReminders(
  now: Date | string = new Date(),
  limit: number = DEFAULT_TICK_LIMIT
): Promise<ReminderTickResult> {
  const result: ReminderTickResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    recurrencesScheduled: 0,
  };

  const nowDate = toDate(now);
  const nowIso = nowDate.toISOString();

  let due: ReminderRecord[];
  try {
    due = await listDueReminders(nowIso, limit);
  } catch {
    console.error('[reminders] Could not load due reminders.');
    return result;
  }

  result.processed = due.length;

  for (const reminder of due) {
    try {
      await processOne(reminder, nowDate, nowIso, result);
    } catch (error) {
      // Defensive: processOne is itself guarded, but a bug must not abort a tick.
      result.failed += 1;
      const reason = error instanceof Error ? error.message : 'Unexpected error.';
      console.error('[reminders] Unexpected error while processing a reminder.');
      await failReminder(reminder, reason);
    }
  }

  return result;
}

// --- Scheduler loop ----------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** True while the interval loop is armed. */
export function isReminderSchedulerRunning(): boolean {
  return timer !== null;
}

/**
 * Runs one guarded tick. Overlap protection: if a tick is still in flight, the
 * next interval is skipped entirely.
 */
async function runTick(limit: number): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await processDueReminders(new Date(), limit);
  } catch (error) {
    // `processDueReminders` never throws; this is a last-resort guard so an
    // unhandled rejection can never crash the process.
    console.error('[reminders] Tick failed unexpectedly.');
    void error;
  } finally {
    inFlight = false;
  }
}

/**
 * Arms the interval loop. Returns `false` (and does nothing) when Supabase is
 * unconfigured or `REMINDERS_ENABLED` is false, so the scheduler is inert in
 * tests and in misconfigured local boots. Started only by `src/index.ts`.
 */
export function startReminderScheduler(
  options: { intervalMs?: number; limit?: number } = {}
): boolean {
  if (timer) return true;
  if (!config.isSupabaseConfigured || !config.remindersEnabled) return false;

  const intervalMs = Math.max(options.intervalMs ?? config.reminderTickMs, 1000);
  const limit = options.limit ?? DEFAULT_TICK_LIMIT;

  timer = setInterval(() => {
    void runTick(limit);
  }, intervalMs);
  // Do not keep the event loop alive purely for the scheduler.
  timer.unref?.();

  console.log(`[reminders] scheduler started (every ${intervalMs}ms, cap ${limit}/tick)`);
  return true;
}

/** Clears the interval loop (safe to call when not running). */
export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
