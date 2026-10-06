import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../services/supabase';
import { listMappings } from '../services/notion';
import {
  getTaskById as getTaskRecordById,
  getTaskSummary as getTaskSummaryService,
  getTasksGrouped as getTasksGroupedService,
  listTasksForUser,
  TaskQueryError,
} from '../services/tasks';
import type { TaskRecord } from '../services/tasks';

/**
 * Phase 12 — task dashboard controllers.
 *
 * Thin handlers over `services/tasks`: they translate HTTP inputs into service
 * calls and map typed failures to status codes. Every query is scoped to
 * `req.user.id`; a foreign task id is indistinguishable from a missing one
 * (both `404`) and its contents are never exposed.
 *
 * The user's `user_profiles.timezone` is read best-effort (fallback `UTC`) so
 * bucket boundaries are computed in the user's local time, never server time.
 */

const FALLBACK_TIMEZONE = 'UTC';

/** Path ids are opaque; we only guard against empty/oversized input. */
const taskIdParamSchema = z.string().trim().min(1).max(200);

/** A task mirror row plus the resolved Notion database title (when known). */
export interface TaskView extends TaskRecord {
  notion_database_name: string | null;
}

/** True when Supabase is unconfigured (callers then respond `503`). */
function isUnconfigured(): boolean {
  return !supabaseAdmin;
}

/**
 * Best-effort lookup of the caller's IANA timezone. A missing profile or a
 * Supabase error must never fail the request — we fall back to UTC.
 */
async function loadUserTimezone(userId: string): Promise<string> {
  if (!supabaseAdmin) {
    return FALLBACK_TIMEZONE;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .select('timezone')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      return FALLBACK_TIMEZONE;
    }

    const timezone = (data as { timezone?: unknown }).timezone;
    return typeof timezone === 'string' && timezone.trim() ? timezone : FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

/**
 * Attaches `notion_database_name` (the title of the task's mapped Notion
 * database) by joining the caller's `notion_database_mappings`. Best-effort: a
 * mapping-lookup failure leaves the name `null` rather than failing the request.
 */
async function attachDatabaseNames(
  userId: string,
  tasks: TaskRecord[]
): Promise<TaskView[]> {
  if (tasks.length === 0) return [];

  const titlesById = new Map<string, string | null>();
  try {
    const mappings = await listMappings(userId);
    for (const mapping of mappings) {
      titlesById.set(mapping.notionDatabaseId, mapping.databaseTitle);
    }
  } catch {
    // Best-effort enrichment only.
  }

  return tasks.map((task) => ({
    ...task,
    notion_database_name: task.notion_database_id
      ? titlesById.get(task.notion_database_id) ?? null
      : null,
  }));
}

/**
 * `GET /api/tasks`
 *
 * Lists the caller's tasks with optional `status`, `dueBefore`, `dueAfter`,
 * `category`, and `limit` filters (Zod-validated → `400` when malformed).
 */
export async function getTasks(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Task storage is not configured' });
    return;
  }

  try {
    const tasks = await listTasksForUser(userId, req.query);
    const enriched = await attachDatabaseNames(userId, tasks);
    res.json({ tasks: enriched });
  } catch (error) {
    if (error instanceof TaskQueryError) {
      res.status(400).json({ error: 'Invalid query parameters' });
      return;
    }
    console.error('[tasks] Could not list tasks.');
    res.status(500).json({ error: 'Could not load tasks' });
  }
}

/**
 * `GET /api/tasks/summary`
 *
 * Returns `{ counts, generatedAt, timezone }` for the six dashboard buckets.
 */
export async function getTaskSummary(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Task storage is not configured' });
    return;
  }

  try {
    const timezone = await loadUserTimezone(userId);
    const summary = await getTaskSummaryService(userId, timezone);
    res.json(summary);
  } catch {
    console.error('[tasks] Could not build the task summary.');
    res.status(500).json({ error: 'Could not load the task summary' });
  }
}

/**
 * `GET /api/tasks/grouped`
 *
 * Returns `{ buckets, generatedAt, timezone }` — the per-bucket task lists the
 * dashboard renders without extra round-trips.
 */
export async function getTasksGrouped(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Task storage is not configured' });
    return;
  }

  try {
    const timezone = await loadUserTimezone(userId);
    const grouped = await getTasksGroupedService(userId, timezone);

    const buckets = {
      today: await attachDatabaseNames(userId, grouped.buckets.today),
      upcoming: await attachDatabaseNames(userId, grouped.buckets.upcoming),
      overdue: await attachDatabaseNames(userId, grouped.buckets.overdue),
      inProgress: await attachDatabaseNames(userId, grouped.buckets.inProgress),
      awaitingUpdate: await attachDatabaseNames(userId, grouped.buckets.awaitingUpdate),
      completed: await attachDatabaseNames(userId, grouped.buckets.completed),
    };

    res.json({ buckets, generatedAt: grouped.generatedAt, timezone: grouped.timezone });
  } catch {
    console.error('[tasks] Could not build the grouped task lists.');
    res.status(500).json({ error: 'Could not load grouped tasks' });
  }
}

/**
 * `GET /api/tasks/:id`
 *
 * Returns the caller's task or `404`. A task owned by another user is never
 * distinguishable from a missing one.
 */
export async function getTask(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Task storage is not configured' });
    return;
  }

  const idResult = taskIdParamSchema.safeParse(req.params.id);
  if (!idResult.success) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  try {
    const task = await getTaskRecordById(userId, idResult.data);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const [view] = await attachDatabaseNames(userId, [task]);
    res.json({ task: view });
  } catch {
    console.error('[tasks] Could not load the task.');
    res.status(500).json({ error: 'Could not load the task' });
  }
}
