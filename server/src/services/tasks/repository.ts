import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import type { CreateTaskInput, TaskFilters, UpdateTaskPatch } from '../../validators/task';

/**
 * Server-side repository for the local `assistant_tasks` mirror.
 *
 * Design rules (enforced by every function here):
 *  - Every query is scoped with `.eq('user_id', userId)`. The `userId` always
 *    comes from the authenticated request (`req.user.id`), never the client
 *    body. This is defense-in-depth on top of RLS, which the service-role
 *    client bypasses.
 *  - When Supabase is unconfigured the functions degrade gracefully (`null` /
 *    `[]` / `false`) instead of throwing, so the server can still boot and the
 *    assistant route can skip persistence without crashing.
 *  - These are internal building blocks for later phases; they do NOT call
 *    Notion.
 */

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskStatus =
  | 'not_started'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'overdue';
export type TaskSource = 'assistant' | 'notion' | 'system';

/** Row shape of `public.assistant_tasks`. */
export interface TaskRecord {
  id: string;
  user_id: string;
  notion_page_id: string | null;
  notion_database_id: string | null;
  notion_url: string | null;
  title: string;
  description: string | null;
  category: string | null;
  priority: TaskPriority | null;
  status: TaskStatus;
  due_date: string | null;
  due_time: string | null;
  timezone: string | null;
  source_of_change: TaskSource | null;
  sync_status: string | null;
  last_synced_at: string | null;
  // Phase 15 — follow-up bookkeeping. Optional so existing repository call
  // sites and test fixtures that predate Phase 15 stay valid; the engine
  // defaults a missing value (`follow_up_count ?? 0`, etc.).
  last_follow_up_at?: string | null;
  follow_up_count?: number | null;
  blocking_reason?: string | null;
  awaiting_follow_up?: boolean | null;
  created_at: string;
  updated_at: string;
}

/** Raised when a database operation fails (distinct from "not configured"). */
export class TaskRepositoryError extends Error {
  constructor(operation: string, message: string) {
    super(`[tasks] ${operation} failed: ${message}`);
    this.name = 'TaskRepositoryError';
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_FRAGMENT_MATCHES = 25;

/** Returns the admin client, or `null` when Supabase is not configured. */
function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Escapes LIKE/ILIKE metacharacters so a fragment is matched literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Creates a task mirror row owned by `userId`. */
export async function createTaskRecord(
  userId: string,
  input: CreateTaskInput
): Promise<TaskRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from('assistant_tasks')
    .insert({ user_id: userId, ...input })
    .select('*')
    .single();

  if (error) {
    throw new TaskRepositoryError('createTaskRecord', error.message);
  }

  return (data as TaskRecord | null) ?? null;
}

/** Fetches a single task owned by `userId`, or `null` when absent. */
export async function getTaskById(userId: string, id: string): Promise<TaskRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from('assistant_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new TaskRepositoryError('getTaskById', error.message);
  }

  return (data as TaskRecord | null) ?? null;
}

/**
 * Applies a partial patch to a task owned by `userId`. Status transitions are
 * expressed by including `status` in the patch. `updated_at` is maintained by
 * the database trigger.
 */
export async function updateTaskRecord(
  userId: string,
  id: string,
  patch: UpdateTaskPatch
): Promise<TaskRecord | null> {
  const admin = client();
  if (!admin) return null;

  // An empty patch would make PostgREST reject the request; return the row.
  if (Object.keys(patch).length === 0) {
    return getTaskById(userId, id);
  }

  const { data, error } = await admin
    .from('assistant_tasks')
    .update({ ...patch })
    .eq('user_id', userId)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new TaskRepositoryError('updateTaskRecord', error.message);
  }

  return (data as TaskRecord | null) ?? null;
}

/**
 * Lists task mirror rows owned by `userId` using the provided filters.
 * Results are ordered by due date (soonest first, undated last) then by most
 * recently created.
 */
export async function listTasks(userId: string, filters: TaskFilters = {}): Promise<TaskRecord[]> {
  const admin = client();
  if (!admin) return [];

  let query = admin.from('assistant_tasks').select('*').eq('user_id', userId);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.category) {
    query = query.eq('category', filters.category);
  }
  if (filters.dueAfter) {
    query = query.gte('due_date', filters.dueAfter);
  }
  if (filters.dueBefore) {
    query = query.lte('due_date', filters.dueBefore);
  }

  const { data, error } = await query
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIST_LIMIT);

  if (error) {
    throw new TaskRepositoryError('listTasks', error.message);
  }

  return (data as TaskRecord[] | null) ?? [];
}

/**
 * Deletes a task owned by `userId`. Returns `true` when a row was removed and
 * `false` when no matching row existed (including cross-user attempts, which
 * match nothing because of the `user_id` filter).
 */
export async function deleteTaskRecord(userId: string, id: string): Promise<boolean> {
  const admin = client();
  if (!admin) return false;

  const { data, error } = await admin
    .from('assistant_tasks')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
    .select('id');

  if (error) {
    throw new TaskRepositoryError('deleteTaskRecord', error.message);
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Finds the caller's task mirrored to a Notion page, or `null`.
 * Used by the Phase 16 pull phase to decide create-vs-update.
 */
export async function findTaskByNotionPageId(
  userId: string,
  notionPageId: string
): Promise<TaskRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from('assistant_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('notion_page_id', notionPageId)
    .maybeSingle();

  if (error) {
    throw new TaskRepositoryError('findTaskByNotionPageId', error.message);
  }

  return (data as TaskRecord | null) ?? null;
}

/**
 * Lists the caller's task rows for the sync engine, bounded by `limit`.
 *
 * The engine needs the full row set to (a) count per-`sync_status` values for
 * the status endpoint and (b) select push candidates. Candidate selection
 * (`source_of_change != 'notion'` and `updated_at > last_synced_at`, with a
 * null-means-never) is done in application code: it keeps the query portable
 * across the in-memory test fake and avoids PostgREST `or`/`is` in the hot path.
 */
export async function listTasksForSync(
  userId: string,
  limit = 500
): Promise<TaskRecord[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin
    .from('assistant_tasks')
    .select('*')
    .eq('user_id', userId)
    .limit(limit);

  if (error) {
    throw new TaskRepositoryError('listTasksForSync', error.message);
  }

  return (data as TaskRecord[] | null) ?? [];
}

/** Finds a user's tasks whose title contains `fragment` (case-insensitive). */
export async function findTasksByTitleFragment(
  userId: string,
  fragment: string
): Promise<TaskRecord[]> {
  const admin = client();
  if (!admin) return [];

  const trimmed = fragment.trim();
  if (!trimmed) return [];

  const { data, error } = await admin
    .from('assistant_tasks')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${escapeLikePattern(trimmed)}%`)
    .order('created_at', { ascending: false })
    .limit(MAX_FRAGMENT_MATCHES);

  if (error) {
    throw new TaskRepositoryError('findTasksByTitleFragment', error.message);
  }

  return (data as TaskRecord[] | null) ?? [];
}
