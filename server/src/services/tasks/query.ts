import type { TaskFilters } from '../../validators/task';
import { MAX_TASK_LIST_LIMIT, taskFiltersSchema } from '../../validators/task';
import { listTasks } from './repository';
import type { TaskRecord } from './repository';

/**
 * Phase 12 — task *query* service.
 *
 * Turns the local `assistant_tasks` mirror into the dashboard's read models:
 * timezone-aware summary buckets, per-bucket task lists, and a validated
 * pass-through to the repository for the filterable list.
 *
 * ## Timezone handling (dependency-free)
 *
 * `due_date` / `due_time` are **wall-clock** values the user thinks in (the
 * values the assistant and Notion store). To decide whether a task is "today"
 * we therefore compare its wall-clock fields against the *user's* current local
 * wall-clock — never against `new Date()` in server-local/UTC time. The user's
 * local date and time are derived with `Intl.DateTimeFormat({ timeZone })`, which
 * is built into Node (no date library required) and honours DST for the
 * instant being formatted.
 *
 * The "awaiting update" window is derived by advancing the *instant* by 48h and
 * formatting that instant in the user's timezone — again, no library needed.
 *
 * ## Degradation
 *
 * When Supabase is unconfigured the repository returns `[]`, so every bucket is
 * computed as zero/empty rather than throwing. The HTTP layer additionally
 * surfaces `503`, but the pure query functions stay safe to call anywhere.
 */

/** Bucket names shared by the summary counts and the grouped lists. */
export type TaskBucketName =
  | 'today'
  | 'upcoming'
  | 'overdue'
  | 'inProgress'
  | 'awaitingUpdate'
  | 'completed';

/** Stable ordering used when filling the grouped buckets. */
export const TASK_BUCKET_ORDER: TaskBucketName[] = [
  'today',
  'upcoming',
  'overdue',
  'inProgress',
  'awaitingUpdate',
  'completed',
];

/** Maximum tasks retained per bucket by {@link groupTasks}. */
export const GROUPED_BUCKET_LIMIT = 20;

/** The follow-up window: open tasks due within the next 48 hours are "awaiting update". */
export const AWAITING_WINDOW_HOURS = 48;
const AWAITING_WINDOW_MS = AWAITING_WINDOW_HOURS * 60 * 60 * 1000;

const FALLBACK_TIMEZONE = 'UTC';

export interface TaskSummaryCounts {
  today: number;
  upcoming: number;
  overdue: number;
  inProgress: number;
  awaitingUpdate: number;
  completed: number;
}

export interface TaskSummary {
  counts: TaskSummaryCounts;
  generatedAt: string;
  timezone: string;
}

export interface TaskBuckets {
  today: TaskRecord[];
  upcoming: TaskRecord[];
  overdue: TaskRecord[];
  inProgress: TaskRecord[];
  awaitingUpdate: TaskRecord[];
  completed: TaskRecord[];
}

export interface GroupedTasks {
  buckets: TaskBuckets;
  generatedAt: string;
  timezone: string;
}

/** Raised when the supplied filters fail validation (mapped to HTTP 400). */
export class TaskQueryError extends Error {
  readonly code = 'invalid_filters' as const;

  constructor(message: string) {
    super(`[tasks] ${message}`);
    this.name = 'TaskQueryError';
  }
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat | null>();

/** Returns (and caches) a formatter for `timeZone`, or `null` when invalid. */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (FORMATTER_CACHE.has(timeZone)) {
    return FORMATTER_CACHE.get(timeZone) ?? null;
  }

  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    formatter = null;
  }

  FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

/** Normalises a user timezone, falling back to `UTC` for empty/invalid values. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  const candidate = (timeZone ?? '').trim() || FALLBACK_TIMEZONE;
  return formatterFor(candidate) ? candidate : FALLBACK_TIMEZONE;
}

/** Formats one instant into `{ date: 'YYYY-MM-DD', time: 'HH:mm' }` in `timeZone`. */
function localWallClock(instant: Date, timeZone: string): { date: string; time: string } {
  const formatter = formatterFor(timeZone) ?? formatterFor(FALLBACK_TIMEZONE);
  // `formatterFor('UTC')` is always valid; the non-null assertion is unreachable.
  const parts = (formatter as Intl.DateTimeFormat).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  let hour = pick('hour');
  // Some ICU versions emit '24' for midnight with hour12:false.
  if (hour === '24') hour = '00';

  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${hour}:${pick('minute')}`,
  };
}

/** Everything the classifier needs about "now" in the user's timezone. */
export interface LocalClock {
  timeZone: string;
  date: string;
  time: string;
  cutoffDate: string;
  cutoffTime: string;
}

/** Builds the local wall-clock context (current day + the 48h cutoff). */
export function buildLocalClock(timeZone: string | null | undefined, now: Date): LocalClock {
  const resolved = resolveTimeZone(timeZone);
  const current = localWallClock(now, resolved);
  const cutoff = localWallClock(new Date(now.getTime() + AWAITING_WINDOW_MS), resolved);

  return {
    timeZone: resolved,
    date: current.date,
    time: current.time,
    cutoffDate: cutoff.date,
    cutoffTime: cutoff.time,
  };
}

/** Compares two wall-clock date-times (`YYYY-MM-DD`, `HH:mm`). */
function compareWallClock(
  aDate: string,
  aTime: string,
  bDate: string,
  bTime: string
): number {
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  if (aTime === bTime) return 0;
  return aTime < bTime ? -1 : 1;
}

/** Which buckets a single task belongs to. Buckets intentionally overlap. */
export interface TaskBucketFlags {
  today: boolean;
  upcoming: boolean;
  overdue: boolean;
  inProgress: boolean;
  awaitingUpdate: boolean;
  completed: boolean;
}

/**
 * Classifies one task against the user's local clock.
 *
 *  - `completed`  — `status === 'completed'` (excluded from every open bucket).
 *  - `today`      — open, not `overdue`-status, due on the user's local date.
 *  - `upcoming`   — open, not `overdue`-status, due after the user's local date.
 *  - `overdue`    — open and past due (before today, or today with a due time
 *                   already reached), **or** `status === 'overdue'` regardless
 *                   of the date.
 *  - `inProgress` — `status === 'in_progress'` (a status bucket; may overlap a
 *                   date bucket).
 *  - `awaitingUpdate` — open and (overdue **or** due within the next 48h). This
 *                   is the set the Phase 15 follow-up engine will chase; it is a
 *                   read-only derivation here and Phase 15 may refine it.
 *
 * `cancelled` tasks are treated like `completed`: excluded from open buckets.
 */
export function classifyTask(task: TaskRecord, clock: LocalClock): TaskBucketFlags {
  const status = task.status;
  const completed = status === 'completed';
  const cancelled = status === 'cancelled';
  const closed = completed || cancelled;
  const overdueByStatus = status === 'overdue';

  const dueDate = task.due_date ?? null;
  const dueTime = task.due_time ?? null;

  const dateIsPast = dueDate !== null && dueDate < clock.date;
  const dateIsToday = dueDate !== null && dueDate === clock.date;
  const dateIsFuture = dueDate !== null && dueDate > clock.date;

  // A due time "already reached" today (equal counts as reached).
  const timeReachedToday = dateIsToday && dueTime !== null && dueTime <= clock.time;

  const overdue = overdueByStatus || (!closed && (dateIsPast || timeReachedToday));

  const withinWindow =
    !closed &&
    dueDate !== null &&
    compareWallClock(dueDate, dueTime ?? '23:59', clock.cutoffDate, clock.cutoffTime) <= 0;

  return {
    today: !closed && !overdueByStatus && dateIsToday,
    upcoming: !closed && !overdueByStatus && dateIsFuture,
    overdue,
    inProgress: status === 'in_progress',
    // Phase 15 — the follow-up engine sets `awaiting_follow_up` when it has
    // asked the user about this task. When present we prefer that explicit flag
    // (it also covers a task chased outside the 48h window); the Phase 12
    // derivation remains the fallback.
    awaitingUpdate: !closed && (task.awaiting_follow_up === true || overdue || withinWindow),
    completed,
  };
}

function emptyCounts(): TaskSummaryCounts {
  return {
    today: 0,
    upcoming: 0,
    overdue: 0,
    inProgress: 0,
    awaitingUpdate: 0,
    completed: 0,
  };
}

/**
 * Pure summary computation over an already-fetched task list. Exported so the
 * tests can drive bucket edge cases without touching Supabase.
 */
export function summarizeTasks(
  tasks: TaskRecord[],
  timeZone: string | null | undefined,
  now: Date = new Date()
): TaskSummary {
  const clock = buildLocalClock(timeZone, now);
  const counts = emptyCounts();

  for (const task of tasks) {
    const flags = classifyTask(task, clock);
    if (flags.today) counts.today += 1;
    if (flags.upcoming) counts.upcoming += 1;
    if (flags.overdue) counts.overdue += 1;
    if (flags.inProgress) counts.inProgress += 1;
    if (flags.awaitingUpdate) counts.awaitingUpdate += 1;
    if (flags.completed) counts.completed += 1;
  }

  return { counts, generatedAt: now.toISOString(), timezone: clock.timeZone };
}

function emptyBuckets(): TaskBuckets {
  return {
    today: [],
    upcoming: [],
    overdue: [],
    inProgress: [],
    awaitingUpdate: [],
    completed: [],
  };
}

/**
 * Pure bucketing over an already-fetched task list. Each bucket is bounded to
 * {@link GROUPED_BUCKET_LIMIT} entries (repository order is preserved).
 */
export function groupTasks(
  tasks: TaskRecord[],
  timeZone: string | null | undefined,
  now: Date = new Date()
): GroupedTasks {
  const clock = buildLocalClock(timeZone, now);
  const buckets = emptyBuckets();

  for (const task of tasks) {
    const flags = classifyTask(task, clock);
    for (const name of TASK_BUCKET_ORDER) {
      if (flags[name] && buckets[name].length < GROUPED_BUCKET_LIMIT) {
        buckets[name].push(task);
      }
    }
  }

  return { buckets, generatedAt: now.toISOString(), timezone: clock.timeZone };
}

/** Summary counts for the caller's tasks, computed in the supplied timezone. */
export async function getTaskSummary(
  userId: string,
  timeZone: string | null | undefined,
  now: Date = new Date()
): Promise<TaskSummary> {
  const tasks = await listTasks(userId, { limit: MAX_TASK_LIST_LIMIT });
  return summarizeTasks(tasks, timeZone, now);
}

/** Per-bucket task lists for the caller, computed in the supplied timezone. */
export async function getTasksGrouped(
  userId: string,
  timeZone: string | null | undefined,
  now: Date = new Date()
): Promise<GroupedTasks> {
  const tasks = await listTasks(userId, { limit: MAX_TASK_LIST_LIMIT });
  return groupTasks(tasks, timeZone, now);
}

/**
 * Validated pass-through to the repository for the filterable task list.
 * Throws {@link TaskQueryError} when the filters are malformed.
 */
export async function listTasksForUser(userId: string, rawFilters: unknown): Promise<TaskRecord[]> {
  const parsed = taskFiltersSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw new TaskQueryError('Invalid task filters');
  }

  const filters: TaskFilters = parsed.data;
  return listTasks(userId, filters);
}
