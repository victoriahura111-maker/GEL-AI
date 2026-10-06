import type { Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase';
import { getTaskById, listTasks } from '../services/tasks';
import type { TaskRecord } from '../services/tasks';
import {
  computeScheduledFor,
  createReminder,
  getReminderById,
  listRemindersForUser,
  cancelReminder as cancelReminderRecord,
  rescheduleReminder as rescheduleReminderRecord,
  ReminderScheduleError,
} from '../services/reminders';
import type { ComputedSchedule, ReminderRecord, TaskDeadline } from '../services/reminders';
import {
  createReminderBodySchema,
  reminderIdParamSchema,
  reminderListQuerySchema,
  rescheduleReminderBodySchema,
} from '../validators/reminder';

/**
 * Phase 13 — `/api/reminders` controllers.
 *
 * Thin handlers over `services/reminders`: they translate HTTP inputs into
 * service calls and map typed failures to status codes. Every query is scoped to
 * `req.user.id`; a foreign reminder is indistinguishable from a missing one
 * (both `404`). Raw payloads/tokens are never returned.
 */

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Compact task reference attached to a reminder for the UI. */
export interface ReminderTaskView {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  status: string;
  notion_url: string | null;
}

export type ReminderView = ReminderRecord & { task: ReminderTaskView | null };

function isUnconfigured(): boolean {
  return !supabaseAdmin;
}

function toTaskView(task: TaskRecord): ReminderTaskView {
  return {
    id: task.id,
    title: task.title,
    due_date: task.due_date,
    due_time: task.due_time,
    status: task.status,
    notion_url: task.notion_url,
  };
}

/** Builds reminder views, attaching the related task (best-effort). */
async function buildViews(
  userId: string,
  reminders: ReminderRecord[]
): Promise<ReminderView[]> {
  const byId = new Map<string, ReminderTaskView>();
  try {
    const tasks = await listTasks(userId, { limit: 200 });
    for (const task of tasks) byId.set(task.id, toTaskView(task));
  } catch {
    // Enrichment only — a lookup failure must not fail the request.
  }

  return reminders.map((reminder) => ({
    ...reminder,
    task: byId.get(reminder.task_id) ?? null,
  }));
}

/** Resolves the deadline used by `before`-mode scheduling. */
function deadlineOf(task: TaskRecord): TaskDeadline | null {
  if (!task.due_date) return null;
  return { dueDate: task.due_date, dueTime: task.due_time };
}

/**
 * Computes the schedule for a body carrying one of `scheduledFor`/`datetime`
 * (absolute) or `before` (relative). `scheduledFor`/`datetime` win over
 * `before` when more than one is supplied.
 */
function resolveSchedule(
  body: {
    scheduledFor?: string;
    datetime?: string;
    before?: string;
    timezone?: string | null;
  },
  deadline: TaskDeadline | null
): ComputedSchedule {
  const absolute = body.scheduledFor ?? body.datetime;
  if (absolute) {
    return computeScheduledFor({
      mode: 'at',
      datetime: absolute,
      timezone: body.timezone,
    });
  }

  return computeScheduledFor({
    mode: 'before',
    before: body.before,
    deadline,
    timezone: body.timezone,
  });
}

function respondScheduleError(res: Response, error: ReminderScheduleError): void {
  res.status(400).json({ error: 'Invalid reminder schedule', code: error.code });
}

/**
 * `GET /api/reminders`
 *
 * Lists the caller's reminders, soonest first. With no window supplied it
 * defaults to *recent + upcoming* (7 days back through 30 days ahead).
 */
export async function getReminders(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Reminder storage is not configured' });
    return;
  }

  const parsed = reminderListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  const filters = parsed.data;
  let from = filters.from;
  let to = filters.to;
  if (!from && !to) {
    const now = Date.now();
    from = new Date(now - RECENT_WINDOW_MS).toISOString();
    to = new Date(now + UPCOMING_WINDOW_MS).toISOString();
  }

  try {
    const reminders = await listRemindersForUser(userId, {
      ...(filters.status ? { status: filters.status } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(filters.limit ? { limit: filters.limit } : {}),
    });

    res.json({ reminders: await buildViews(userId, reminders) });
  } catch {
    console.error('[reminders] Could not list reminders.');
    res.status(500).json({ error: 'Could not load reminders' });
  }
}

/**
 * `POST /api/reminders/:id/cancel`
 *
 * Cancels an owned reminder; `404` when it does not exist / is not owned.
 */
export async function postCancelReminder(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Reminder storage is not configured' });
    return;
  }

  const id = reminderIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }

  try {
    const cancelled = await cancelReminderRecord(userId, id.data);
    if (!cancelled) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }

    const [view] = await buildViews(userId, [cancelled]);
    res.json({ reminder: view });
  } catch {
    console.error('[reminders] Could not cancel the reminder.');
    res.status(500).json({ error: 'Could not cancel the reminder' });
  }
}

/**
 * `POST /api/reminders/:id/reschedule`
 *
 * Re-arms an owned reminder at a new time (`scheduledFor`/`datetime` absolute, or
 * `before` relative to the task deadline). Returns the updated reminder.
 */
export async function postRescheduleReminder(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Reminder storage is not configured' });
    return;
  }

  const id = reminderIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: 'Reminder not found' });
    return;
  }

  const body = rescheduleReminderBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'Invalid reschedule request',
      details: body.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const reminder = await getReminderById(userId, id.data);
    if (!reminder) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }

    const task = await getTaskById(userId, reminder.task_id);
    if (!task) {
      res.status(400).json({ error: 'The related task is unavailable' });
      return;
    }

    let schedule;
    try {
      schedule = resolveSchedule(body.data, deadlineOf(task));
    } catch (error) {
      if (error instanceof ReminderScheduleError) {
        respondScheduleError(res, error);
        return;
      }
      throw error;
    }

    // Ownership is already verified; `rescheduleReminder` re-arms (resets
    // status to pending and clears any prior sent_at/failure_reason).
    const updated = await rescheduleReminderRecord(id.data, schedule.scheduledFor, schedule.timezone);
    if (!updated) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }

    res.json({ reminder: { ...updated, task: toTaskView(task) } });
  } catch {
    console.error('[reminders] Could not reschedule the reminder.');
    res.status(500).json({ error: 'Could not reschedule the reminder' });
  }
}

/**
 * `POST /api/reminders`
 *
 * Creates a reminder for one of the caller's tasks. Scheduling reuses
 * `computeScheduledFor` (the same helper the assistant flow uses).
 */
export async function postCreateReminder(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Reminder storage is not configured' });
    return;
  }

  const body = createReminderBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'Invalid reminder request',
      details: body.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    // Ownership: the task must belong to the caller. A foreign id is a 404.
    const task = await getTaskById(userId, body.data.taskId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    let schedule;
    try {
      schedule = resolveSchedule(body.data, deadlineOf(task));
    } catch (error) {
      if (error instanceof ReminderScheduleError) {
        respondScheduleError(res, error);
        return;
      }
      throw error;
    }

    const created = await createReminder(userId, {
      taskId: task.id,
      scheduledFor: schedule.scheduledFor,
      timezone: schedule.timezone,
      channel: 'in_app',
      recurrence: body.data.recurrence ?? null,
    });

    if (!created) {
      res.status(500).json({ error: 'Could not create the reminder' });
      return;
    }

    res.status(201).json({ reminder: { ...created, task: toTaskView(task) } });
  } catch {
    console.error('[reminders] Could not create the reminder.');
    res.status(500).json({ error: 'Could not create the reminder' });
  }
}
