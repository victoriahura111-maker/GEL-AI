import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import type { TaskRecord } from '../tasks/repository';

/**
 * Phase 15 — `assistant_tasks` follow-up persistence.
 *
 * Two responsibilities:
 *  - the **worker read** (`listOpenTasksForFollowUp`) — a cross-user scan of
 *    open tasks, mirroring the reminder engine's `listDueReminders`. It is not
 *    user-scoped by design (the scheduler serves every user); it only selects
 *    the columns the engine needs.
 *  - the **state writes** (`updateFollowUpFields`) — always scoped by
 *    `user_id` as defense-in-depth, used to record a sent follow-up and to
 *    clear/replace the conversational state.
 *
 * Degradation: when Supabase is unconfigured reads return `[]` and writes
 * return `null` (never throw), so the server still boots.
 */

const TABLE = 'assistant_tasks';

/** Statuses that are still "open" (eligible for follow-up). `blocked` included. */
export const OPEN_TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'overdue'] as const;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Raised when a follow-up database operation fails. */
export class FollowUpRepositoryError extends Error {
  constructor(operation: string, message: string) {
    super(`[followup] ${operation} failed: ${message}`);
    this.name = 'FollowUpRepositoryError';
  }
}

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/**
 * Worker query: open tasks (not `completed`/`cancelled`) that have a due date,
 * soonest deadline first. Cross-user by design — the timezone/accepted-window
 * filtering happens in application code (`candidates.ts`).
 */
export async function listOpenTasksForFollowUp(limit: number = DEFAULT_LIMIT): Promise<TaskRecord[]> {
  const admin = client();
  if (!admin) return [];

  const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .in('status', [...OPEN_TASK_STATUSES])
    .not('due_date', 'is', null)
    .order('due_date', { ascending: true })
    .limit(capped);

  if (error) {
    throw new FollowUpRepositoryError('listOpenTasksForFollowUp', error.message);
  }

  return (data as TaskRecord[] | null) ?? [];
}

/** Partial patch for {@link updateFollowUpFields}. Only provided keys are written. */
export interface FollowUpFieldsPatch {
  last_follow_up_at?: string | null;
  follow_up_count?: number;
  blocking_reason?: string | null;
  awaiting_follow_up?: boolean;
}

/**
 * Updates the follow-up bookkeeping columns of a task owned by `userId`. Returns
 * the updated row, or `null` when no owned row matched (or Supabase is
 * unconfigured). An empty patch returns the current row unchanged.
 */
export async function updateFollowUpFields(
  userId: string,
  taskId: string,
  patch: FollowUpFieldsPatch
): Promise<TaskRecord | null> {
  const admin = client();
  if (!admin) return null;

  if (Object.keys(patch).length === 0) {
    const { data, error } = await admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('id', taskId)
      .maybeSingle();
    if (error) throw new FollowUpRepositoryError('updateFollowUpFields', error.message);
    return (data as TaskRecord | null) ?? null;
  }

  const { data, error } = await admin
    .from(TABLE)
    .update({ ...patch })
    .eq('user_id', userId)
    .eq('id', taskId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new FollowUpRepositoryError('updateFollowUpFields', error.message);
  }

  return (data as TaskRecord | null) ?? null;
}

/** Clears the `awaiting_follow_up` flag for an owned task. */
export async function clearAwaitingFollowUp(
  userId: string,
  taskId: string
): Promise<TaskRecord | null> {
  return updateFollowUpFields(userId, taskId, { awaiting_follow_up: false });
}
