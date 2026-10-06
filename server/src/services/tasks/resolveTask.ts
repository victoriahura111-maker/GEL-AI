import { findTasksByTitleFragment, listTasks } from './repository';
import type { TaskRecord } from './repository';

/**
 * Phase 11 — task resolution + disambiguation.
 *
 * Given a free-form `identifier` (typically a `task_identifier` extracted from
 * the user's message), `resolveTask` finds the local-mirror task the user most
 * likely means. It is deliberately conservative: when several tasks are equally
 * plausible it returns `ambiguous` with candidates so the assistant can ask
 * ("I found three reports. Which one do you mean?") instead of guessing.
 *
 * Design rules:
 *  - Every query is scoped to `userId`; another user's tasks can never be
 *    returned (the underlying repository filters on `user_id`).
 *  - Ranking is deterministic: exact > prefix > substring, then open before
 *    closed, then nearest due date, then most recently created.
 *  - The fragment is matched case-insensitively against BOTH the title and the
 *    category (the repository matches the title; category matches are merged in
 *    locally from the user's task list).
 */

export type TaskResolution =
  | { status: 'found'; task: TaskRecord }
  | { status: 'ambiguous'; candidates: TaskRecord[] }
  | { status: 'not_found' };

/** How strongly a task matched the identifier (lower is better). */
type MatchRank = 0 | 1 | 2 | 3;

/** Closed states cannot be the target of a "prefer open" tie-break. */
function isClosed(task: TaskRecord): boolean {
  return task.status === 'completed' || task.status === 'cancelled';
}

/** Ranks `fragment` against a task's title + category. Returns `null` if no match. */
function rankMatch(task: TaskRecord, fragment: string): MatchRank | null {
  const title = task.title.trim().toLowerCase();
  if (title === fragment) return 0;
  if (title.startsWith(fragment)) return 1;
  if (title.includes(fragment)) return 2;

  const category = (task.category ?? '').trim().toLowerCase();
  if (category.includes(fragment)) return 3;

  return null;
}

/** Epoch milliseconds for a task's due date, or `Infinity` when undated. */
function dueEpoch(task: TaskRecord): number {
  if (!task.due_date) return Number.POSITIVE_INFINITY;
  const time = task.due_time ? `${task.due_date}T${task.due_time}:00Z` : `${task.due_date}T00:00:00Z`;
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Deterministic comparator: match rank, then open-first, then nearest due. */
function compareCandidates(a: TaskRecord, b: TaskRecord, fragment: string): number {
  const rankA = rankMatch(a, fragment) ?? 9;
  const rankB = rankMatch(b, fragment) ?? 9;
  if (rankA !== rankB) return rankA - rankB;

  const closedA = isClosed(a) ? 1 : 0;
  const closedB = isClosed(b) ? 1 : 0;
  if (closedA !== closedB) return closedA - closedB;

  const dueA = dueEpoch(a);
  const dueB = dueEpoch(b);
  if (dueA !== dueB) return dueA - dueB;

  // Newest first as a final stable tie-break.
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Merges two task lists, de-duplicating by id (title matches win). */
function mergeUnique(primary: TaskRecord[], secondary: TaskRecord[]): TaskRecord[] {
  const seen = new Set(primary.map((task) => task.id));
  const merged = [...primary];
  for (const task of secondary) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      merged.push(task);
    }
  }
  return merged;
}

/**
 * Most-recently-updated open task for the "no identifier supplied" case, or
 * `null` when the user has no open task.
 */
async function mostRecentOpenTask(userId: string): Promise<TaskRecord | null> {
  const all = await listTasks(userId);
  const open = all.filter((task) => !isClosed(task));
  if (open.length === 0) return null;

  return open.reduce((latest, task) => {
    const latestAt = Date.parse(latest.updated_at ?? latest.created_at);
    const taskAt = Date.parse(task.updated_at ?? task.created_at);
    return taskAt > latestAt ? task : latest;
  });
}

/**
 * Resolves the task referenced by `identifier` for `userId`.
 *
 * - Empty/blank `identifier` → the most recently updated open task
 *   (`found`), else `not_found`.
 * - Otherwise title + category fragment matches are ranked; a clear winner is
 *   `found`, equally-ranked contenders are `ambiguous`, and no match is
 *   `not_found`.
 */
export async function resolveTask(
  userId: string,
  identifier?: string | null
): Promise<TaskResolution> {
  const fragment = (identifier ?? '').trim().toLowerCase();

  if (!fragment) {
    const recent = await mostRecentOpenTask(userId);
    return recent ? { status: 'found', task: recent } : { status: 'not_found' };
  }

  const titleMatches = await findTasksByTitleFragment(userId, fragment);

  // Category matches: fetch the caller's list once and keep the ones whose
  // category contains the fragment (the repository only matches the title).
  let categoryMatches: TaskRecord[] = [];
  try {
    const all = await listTasks(userId);
    categoryMatches = all.filter((task) =>
      (task.category ?? '').trim().toLowerCase().includes(fragment)
    );
  } catch {
    // A list failure must not break resolution; title matches still apply.
    categoryMatches = [];
  }

  const candidates = mergeUnique(titleMatches, categoryMatches).filter(
    (task) => rankMatch(task, fragment) !== null
  );

  if (candidates.length === 0) {
    return { status: 'not_found' };
  }

  candidates.sort((a, b) => compareCandidates(a, b, fragment));

  const best = candidates[0];
  const bestRank = rankMatch(best, fragment) ?? 9;
  const bestClosed = isClosed(best);

  // Two candidates are indistinguishable only when their match rank, open/closed
  // state AND due date all agree. The sort has already put the best (open,
  // nearest-due) candidate first, so a unique top group is a confident match and
  // anything else must be disambiguated by the user.
  const tied = candidates.filter(
    (task) =>
      (rankMatch(task, fragment) ?? 9) === bestRank &&
      isClosed(task) === bestClosed &&
      task.due_date === best.due_date
  );

  if (tied.length === 1) {
    return { status: 'found', task: best };
  }

  return { status: 'ambiguous', candidates: tied };
}
