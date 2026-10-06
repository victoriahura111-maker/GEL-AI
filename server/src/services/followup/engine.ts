import { config } from '../../config';
import { writeAuditLog } from '../audit/auditLog';
import { dispatchNotification } from '../notifications';
import type { AppNotification } from '../notifications';
import type { FollowUpCard } from '../ai/toCards';
import { selectFollowUpCandidates } from './candidates';
import type { FollowUpCandidate } from './candidates';
import { updateFollowUpFields } from './repository';
import type { TaskRecord } from '../tasks/repository';

/**
 * Phase 15 — follow-up engine.
 *
 * `processFollowUps` is the **testable core**: a single, throw-free tick that
 * selects the tasks the user should be chased about, delivers a follow-up (a
 * message + an interactive `follow_up` card) through the notification layer,
 * and records the anti-spam bookkeeping (`last_follow_up_at`, `follow_up_count`,
 * `awaiting_follow_up`).
 *
 * The card + message are dispatched via `dispatchNotification` targeting the
 * in-app channel, which persists a notification-center row **and** appends the
 * proactive assistant message carrying the card so the user can respond inline.
 *
 * ## Anti-spam
 *
 * Selection already enforces the per-task cap and the minimum interval (see
 * `candidates.ts`); the engine additionally applies a hard per-tick cap.
 *
 * ## Failure isolation
 *
 * A failure on one candidate (dispatch error, state-write error) is logged and
 * never aborts the tick. The selection query is guarded too: a failure yields
 * an empty result.
 */

/** Aggregate outcome of one tick. */
export interface FollowUpTickResult {
  /** Candidates considered this tick (after anti-spam filtering). */
  processed: number;
  /** Follow-ups delivered and recorded. */
  sent: number;
  /** Candidates that could not be delivered/recorded. */
  failed: number;
  /** Reserved for symmetry with the reminder engine (unused today). */
  skipped: number;
}

/** Hard per-tick cap so a large backlog cannot monopolise the loop. */
export const DEFAULT_FOLLOW_UP_TICK_LIMIT = 50;

/** Channels a follow-up is delivered through (in-app only today). */
export const FOLLOW_UP_CHANNELS = ['in_app'];

function toDate(now: Date | string | undefined): Date {
  if (now instanceof Date) return now;
  if (typeof now === 'string') {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Human "due soon" phrase: "tomorrow" near a day out, else "in N hours". */
export function describeDueSoon(hoursUntilDue: number): string {
  if (hoursUntilDue >= 20 && hoursUntilDue <= 28) return 'tomorrow';
  const hours = Math.max(1, Math.round(hoursUntilDue));
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Human overdue phrase: "yesterday" near a day late, else "N days ago". */
export function describeOverdue(hoursUntilDue: number): string {
  const hoursLate = -hoursUntilDue;
  const days = Math.max(1, Math.round(hoursLate / 24));
  if (days <= 1) return 'yesterday';
  return `${days} days ago`;
}

/** Builds the interactive `follow_up` card for a candidate. */
export function buildFollowUpCard(candidate: FollowUpCandidate): FollowUpCard {
  const { task, kind, hoursUntilDue } = candidate;

  if (kind === 'due_soon') {
    const dueLabel = describeDueSoon(hoursUntilDue);
    return {
      type: 'follow_up',
      kind,
      taskId: task.id,
      taskTitle: task.title,
      dueLabel,
      prompt: `Your "${task.title}" is due ${dueLabel}. How is it going?`,
      actions: ['completed', 'in_progress', 'blocked', 'need_more_time'],
    };
  }

  const dueLabel = describeOverdue(hoursUntilDue);
  return {
    type: 'follow_up',
    kind: 'overdue',
    taskId: task.id,
    taskTitle: task.title,
    dueLabel,
    prompt: `Your "${task.title}" was due ${dueLabel}. Would you like to:`,
    actions: ['mark_completed', 'continue_working', 'move_deadline'],
  };
}

/** Builds the channel-agnostic notification (message + card) for a candidate. */
export function buildFollowUpNotification(candidate: FollowUpCandidate): AppNotification {
  const card = buildFollowUpCard(candidate);

  return {
    userId: candidate.task.user_id,
    type: 'follow_up',
    title: candidate.kind === 'overdue' ? `Overdue: ${candidate.task.title}` : `Due soon: ${candidate.task.title}`,
    body: card.prompt,
    taskId: candidate.task.id,
    notionUrl: candidate.task.notion_url ?? null,
    cards: [card],
    metadata: {
      kind: candidate.kind,
      dueDate: candidate.task.due_date,
      dueTime: candidate.task.due_time,
      followUpCount: candidate.task.follow_up_count ?? 0,
    },
  };
}

/** Best-effort audit write; never throws. */
async function audit(
  action: 'follow_up_sent' | 'follow_up_failed',
  task: TaskRecord,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await writeAuditLog(task.user_id, {
      action,
      taskId: task.id,
      notionPageId: task.notion_page_id,
      toolName: 'follow_up_engine',
      metadata,
    });
  } catch {
    console.error('[followup] Could not write a follow-up audit row.');
  }
}

/** Processes one candidate. Never throws. */
async function processOne(
  candidate: FollowUpCandidate,
  nowIso: string,
  result: FollowUpTickResult
): Promise<void> {
  const task = candidate.task;
  const notification = buildFollowUpNotification(candidate);

  // (1) Deliver the message + card through the notification layer.
  let delivered = false;
  try {
    const dispatch = await dispatchNotification(notification, { channels: FOLLOW_UP_CHANNELS });
    delivered = dispatch.delivered > 0;
  } catch {
    delivered = false;
  }

  if (!delivered) {
    result.failed += 1;
    await audit('follow_up_failed', task, { kind: candidate.kind, reason: 'dispatch_failed' });
    return;
  }

  // (2) Record the anti-spam bookkeeping. If this fails the task would be
  // eligible again on the next tick, so it is surfaced as a failure (isolated).
  const nextCount = (task.follow_up_count ?? 0) + 1;
  try {
    await updateFollowUpFields(task.user_id, task.id, {
      last_follow_up_at: nowIso,
      follow_up_count: nextCount,
      awaiting_follow_up: true,
    });
  } catch {
    result.failed += 1;
    await audit('follow_up_failed', task, { kind: candidate.kind, reason: 'state_update_failed' });
    return;
  }

  await audit('follow_up_sent', task, {
    kind: candidate.kind,
    follow_up_count: nextCount,
    due_date: task.due_date,
  });
  result.sent += 1;
}

/**
 * Runs one follow-up tick: select candidates, deliver each, record outcomes.
 * Never throws — a failure anywhere is isolated and reflected in the result.
 */
export async function processFollowUps(
  now: Date | string = new Date(),
  limit: number = DEFAULT_FOLLOW_UP_TICK_LIMIT
): Promise<FollowUpTickResult> {
  const result: FollowUpTickResult = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  const nowDate = toDate(now);
  const nowIso = nowDate.toISOString();

  let candidates: FollowUpCandidate[];
  try {
    candidates = await selectFollowUpCandidates(nowIso, {
      leadHours: config.followUpLeadHours,
      minIntervalHours: config.followUpMinIntervalHours,
      maxPerTask: config.followUpMaxPerTask,
    });
  } catch {
    console.error('[followup] Could not select follow-up candidates.');
    return result;
  }

  const capped = candidates.slice(0, Math.max(1, limit));
  result.processed = capped.length;

  for (const candidate of capped) {
    try {
      await processOne(candidate, nowIso, result);
    } catch (error) {
      // Defensive: processOne is itself guarded, but a bug must not abort a tick.
      result.failed += 1;
      console.error('[followup] Unexpected error while processing a candidate.');
      void error;
    }
  }

  return result;
}
