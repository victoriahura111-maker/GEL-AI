import { writeAuditLog } from '../audit/auditLog';
import { getTaskById } from '../tasks/repository';
import type { TaskRecord } from '../tasks/repository';
import { applyTaskUpdate } from '../tasks/updateTask';
import { parseDateTime, toWallClockParts, ReminderScheduleError } from '../reminders/schedule';
import { resolveTimeZone } from '../tasks/query';
import { updateFollowUpFields } from './repository';

/**
 * Phase 15 — follow-up response handling.
 *
 * Turns a user's answer to a follow-up card (or a conversational reply) into a
 * concrete task mutation. Every path:
 *  - enforces ownership (`getTaskById` is scoped to the user → `not_found`),
 *  - clears `awaiting_follow_up`,
 *  - audits a `follow_up_response` row,
 *  - and returns a user-safe confirmation message.
 *
 * Response vocabulary (the union covers both the `due_soon` and `overdue` card
 * button sets):
 *
 *  - `completed` / `mark_completed` → status `completed`.
 *  - `in_progress` / `continue_working` → status `in_progress`. For an overdue
 *    card, `continue_working` is documented to mean "I'm still on it": the task
 *    simply moves back to `in_progress` (and may be chased again later).
 *  - `blocked` → status `blocked`, stores `blocking_reason` (when supplied) and
 *    replies asking "What is blocking you?" until a reason is given.
 *  - `need_more_time` / `move_deadline` → requires a new deadline, parsed with
 *    the reminder `schedule` helpers and applied as `due_date`/`due_time`.
 */

/** The answers a follow-up card (or free text) can produce. */
export type FollowUpResponseVerb =
  | 'completed'
  | 'mark_completed'
  | 'in_progress'
  | 'continue_working'
  | 'blocked'
  | 'need_more_time'
  | 'move_deadline';

/** Input for {@link handleFollowUpResponse}. */
export interface HandleFollowUpResponseInput {
  taskId: string;
  response: FollowUpResponseVerb;
  /** The blocking reason, for the `blocked` verb. */
  reason?: string;
  /** The new deadline (ISO date or date-time), for the reschedule verbs. */
  newDeadline?: string;
  /** Overrides the task's own timezone when parsing/formatting a deadline. */
  timezone?: string | null;
}

/** Matches a date-only deadline (`YYYY-MM-DD`). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Result of {@link handleFollowUpResponse}. */
export type HandleFollowUpResponseResult =
  | { status: 'ok'; task: TaskRecord | null; message: string; notionUrl: string | null }
  | { status: 'not_found' }
  | { status: 'needs_deadline'; message: string }
  | { status: 'invalid_deadline'; message: string };

/** Best-effort audit write; never throws. */
async function audit(
  userId: string,
  task: TaskRecord,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await writeAuditLog(userId, {
      action: 'follow_up_response',
      taskId: task.id,
      notionPageId: task.notion_page_id,
      toolName: 'follow_up_response',
      metadata,
    });
  } catch {
    console.error('[followup] Could not write a follow-up response audit row.');
  }
}

/** Clears `awaiting_follow_up` best-effort (a failure must not fail the reply). */
async function clearAwaiting(userId: string, taskId: string): Promise<void> {
  try {
    await updateFollowUpFields(userId, taskId, { awaiting_follow_up: false });
  } catch {
    console.error('[followup] Could not clear awaiting_follow_up.');
  }
}

/**
 * Applies a response to the task owned by `userId`. Never throws for expected
 * outcomes; unexpected errors (e.g. a Notion rejection) propagate to the route.
 */
export async function handleFollowUpResponse(
  userId: string,
  input: HandleFollowUpResponseInput
): Promise<HandleFollowUpResponseResult> {
  const task = await getTaskById(userId, input.taskId);
  if (!task) {
    return { status: 'not_found' };
  }

  const verb = input.response;

  // --- Reschedule (requires a new deadline) ---------------------------------
  if (verb === 'need_more_time' || verb === 'move_deadline') {
    const rawDeadline = (input.newDeadline ?? '').trim();
    if (!rawDeadline) {
      return {
        status: 'needs_deadline',
        message:
          'Sure — what date would you like to move it to? You can say something like "next Monday".',
      };
    }

    const timeZone = resolveTimeZone(input.timezone ?? task.timezone);
    let wall: { date: string; time: string };
    try {
      const instant = parseDateTime(rawDeadline, timeZone);
      wall = toWallClockParts(instant, timeZone);
    } catch (error) {
      if (error instanceof ReminderScheduleError) {
        return {
          status: 'invalid_deadline',
          message: "I couldn't understand that date. Try something like 2026-10-12 or 2026-10-12 17:00.",
        };
      }
      throw error;
    }

    // A date-only answer keeps the task date-only (clears any prior due time).
    const dueTime = DATE_ONLY.test(rawDeadline) ? null : wall.time;
    const whenText = dueTime ? `${wall.date} at ${dueTime}` : wall.date;

    const result = await applyTaskUpdate(userId, input.taskId, {
      dueDate: wall.date,
      dueTime,
      timezone: timeZone,
    });
    if (result.status === 'not_found') {
      return { status: 'not_found' };
    }

    await clearAwaiting(userId, input.taskId);
    await audit(userId, task, { response: verb, due_date: wall.date, due_time: dueTime });

    const notionUrl = result.notion?.url ?? null;
    const suffix = notionUrl ? ' and updated the Notion task.' : '.';
    return {
      status: 'ok',
      task: result.task ?? task,
      message: `Done. I've moved the deadline to ${whenText}${suffix}`,
      notionUrl,
    };
  }

  // --- Blocked --------------------------------------------------------------
  if (verb === 'blocked') {
    const reason = (input.reason ?? '').trim();
    const result = await applyTaskUpdate(userId, input.taskId, { status: 'blocked' });
    if (result.status === 'not_found') {
      return { status: 'not_found' };
    }

    try {
      await updateFollowUpFields(userId, input.taskId, {
        awaiting_follow_up: false,
        blocking_reason: reason || null,
      });
    } catch {
      console.error('[followup] Could not store the blocking reason.');
    }

    await audit(userId, task, { response: verb, has_reason: Boolean(reason) });

    const message = reason
      ? `Got it — I've marked "${task.title}" as blocked and noted: "${reason}".`
      : `Got it — I've marked "${task.title}" as blocked. What is blocking you?`;

    return { status: 'ok', task: result.task ?? task, message, notionUrl: result.notion?.url ?? null };
  }

  // --- Status updates -------------------------------------------------------
  const status = verb === 'completed' || verb === 'mark_completed' ? 'completed' : 'in_progress';
  const result = await applyTaskUpdate(userId, input.taskId, { status });
  if (result.status === 'not_found') {
    return { status: 'not_found' };
  }

  await clearAwaiting(userId, input.taskId);
  await audit(userId, task, { response: verb, status });

  const message =
    status === 'completed'
      ? `Got it — I've marked "${task.title}" as completed.`
      : `Got it. I've updated the task to In Progress.`;

  return { status: 'ok', task: result.task ?? task, message, notionUrl: result.notion?.url ?? null };
}

/** A lightweight conversational expectation inferred from the chat history. */
export interface FollowUpExpectation {
  kind: 'reason' | 'deadline';
  taskTitle: string;
}

/**
 * Phase 15 — pragmatic free-text resolution for follow-up replies.
 *
 * The button/card path is the primary, fully-supported flow. This helper adds a
 * best-effort conversational fallback: when the most recent assistant turn was
 * a follow-up asking for a blocking reason ("...What is blocking you?") or a new
 * deadline ("...Would you like to:" / "what date would you like to move it
 * to?"), the next free-text user message is interpreted as that answer. The
 * task title is recovered from the nearest quoted title in the history.
 *
 * Returns `null` when no follow-up expectation is detected (the caller then
 * falls through to normal AI intent extraction).
 */
export function detectFollowUpExpectation(
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined
): FollowUpExpectation | null {
  if (!history || history.length === 0) return null;

  const REASON = /what is blocking you\?/i;
  const DEADLINE = /(would you like to:|what date would you like to move it to\?)/i;
  const QUOTED = /"([^"]{1,300})"/;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (!turn || turn.role !== 'assistant') continue;

    const kind: 'reason' | 'deadline' | null = REASON.test(turn.content)
      ? 'reason'
      : DEADLINE.test(turn.content)
        ? 'deadline'
        : null;
    if (!kind) continue;

    for (let j = i; j >= 0; j -= 1) {
      const match = QUOTED.exec(history[j]?.content ?? '');
      if (match) return { kind, taskTitle: match[1] };
    }
    return null;
  }

  return null;
}
