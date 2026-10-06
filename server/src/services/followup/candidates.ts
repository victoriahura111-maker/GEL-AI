import { config } from '../../config';
import { resolveTimeZone } from '../tasks/query';
import type { TaskRecord } from '../tasks/repository';
import { resolveDeadlineInstant } from '../reminders/schedule';
import type { FollowUpKind } from '../ai/toCards';
import { listOpenTasksForFollowUp } from './repository';

/**
 * Phase 15 — follow-up candidate selection (pure core + async loader).
 *
 * A candidate is an **open** task (not `completed`/`cancelled`; `blocked` is
 * allowed) that is either:
 *  - **due soon** — its deadline falls within the next `leadHours` (default 24), or
 *  - **overdue**  — its deadline has already passed,
 *
 * subject to two anti-spam guards:
 *  - `follow_up_count < maxPerTask` (default 3), and
 *  - `last_follow_up_at` older than `minIntervalHours` (default 20).
 *
 * ## Timezone correctness
 *
 * `due_date`/`due_time` are **wall-clock** values the user thinks in. A
 * date-only deadline means end-of-day (23:59) in the task/user timezone, and the
 * comparison against `now` is done on absolute instants — resolved with the
 * existing dependency-free `Intl` approach (`resolveTimeZone` +
 * `resolveDeadlineInstant`), never with server-local time.
 *
 * `evaluateFollowUpCandidates` is the **pure** core so tests can drive boundary
 * cases without Supabase; `selectFollowUpCandidates` loads open tasks and
 * delegates to it (never throwing — a load failure yields `[]`).
 */

const HOUR_MS = 60 * 60 * 1000;

/** A task selected for follow-up plus why and when it is due. */
export interface FollowUpCandidate {
  task: TaskRecord;
  kind: FollowUpKind;
  /** The resolved deadline instant (UTC). */
  dueAt: Date;
  /** Hours until the deadline; negative when overdue. */
  hoursUntilDue: number;
}

/** Resolved anti-spam thresholds for one selection pass. */
export interface FollowUpCandidateOptions {
  leadHours: number;
  minIntervalHours: number;
  maxPerTask: number;
}

/** The global defaults sourced from the environment. */
export function defaultFollowUpOptions(): FollowUpCandidateOptions {
  return {
    leadHours: config.followUpLeadHours,
    minIntervalHours: config.followUpMinIntervalHours,
    maxPerTask: config.followUpMaxPerTask,
  };
}

/** True when the task is closed (never chased). */
function isClosed(task: TaskRecord): boolean {
  return task.status === 'completed' || task.status === 'cancelled';
}

/**
 * Pure candidate filter/sorter over an already-fetched task list.
 *
 * @param now    the reference instant.
 * @param options resolved anti-spam thresholds (defaults from config when omitted).
 */
export function evaluateFollowUpCandidates(
  tasks: TaskRecord[],
  now: Date,
  options: FollowUpCandidateOptions = defaultFollowUpOptions()
): FollowUpCandidate[] {
  const minIntervalMs = options.minIntervalHours * HOUR_MS;
  const nowMs = now.getTime();
  const found: FollowUpCandidate[] = [];

  for (const task of tasks) {
    if (isClosed(task)) continue;
    if (!task.due_date) continue;

    // Anti-spam: hard per-task cap.
    const count = task.follow_up_count ?? 0;
    if (count >= options.maxPerTask) continue;

    // Anti-spam: minimum interval since the last follow-up.
    if (task.last_follow_up_at) {
      const lastMs = Date.parse(task.last_follow_up_at);
      if (!Number.isNaN(lastMs) && nowMs - lastMs < minIntervalMs) continue;
    }

    // Resolve the deadline as an absolute instant in the task's timezone.
    let dueAt: Date;
    try {
      dueAt = resolveDeadlineInstant(
        { dueDate: task.due_date, dueTime: task.due_time },
        resolveTimeZone(task.timezone)
      );
    } catch {
      // An unparseable deadline cannot be chased safely.
      continue;
    }

    const diffHours = (dueAt.getTime() - nowMs) / HOUR_MS;

    if (diffHours <= 0) {
      found.push({ task, kind: 'overdue', dueAt, hoursUntilDue: diffHours });
    } else if (diffHours <= options.leadHours) {
      found.push({ task, kind: 'due_soon', dueAt, hoursUntilDue: diffHours });
    }
    // Otherwise the deadline is further out than the lead window: not yet.
  }

  // Soonest deadline first, so the most urgent / most overdue lead the tick.
  return found.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/**
 * Loads open tasks and returns the follow-up candidates for `nowIso`.
 * Never throws: a repository failure yields `[]` (the tick then no-ops).
 */
export async function selectFollowUpCandidates(
  nowIso: string,
  options?: Partial<FollowUpCandidateOptions>
): Promise<FollowUpCandidate[]> {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return [];

  const resolved: FollowUpCandidateOptions = {
    ...defaultFollowUpOptions(),
    ...options,
  };

  let tasks: TaskRecord[];
  try {
    tasks = await listOpenTasksForFollowUp();
  } catch {
    console.error('[followup] Could not load open tasks.');
    return [];
  }

  return evaluateFollowUpCandidates(tasks, now, resolved);
}
