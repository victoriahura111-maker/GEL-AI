import { z } from 'zod';

/** Enumerated task fields (mirror the CHECK constraints in `0004_assistant_tasks.sql`). */
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TASK_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
  'overdue',
] as const;
export const TASK_SOURCES = ['assistant', 'notion', 'system'] as const;

/** Server-side cap on how many tasks a single list query may return. */
export const MAX_TASK_LIST_LIMIT = 100;

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour time (HH:mm).');

/**
 * Fields accepted when creating a task mirror row. `user_id` is deliberately
 * absent: it is always supplied by the server from the authenticated request,
 * never by the caller.
 */
export const createTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z.string().trim().max(120).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    due_date: isoDate.nullable().optional(),
    due_time: clockTime.nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    source_of_change: z.enum(TASK_SOURCES).optional(),
    sync_status: z.string().trim().max(64).nullable().optional(),
    notion_page_id: z.string().trim().max(200).nullable().optional(),
    notion_database_id: z.string().trim().max(200).nullable().optional(),
    notion_url: z.string().trim().url().max(500).nullable().optional(),
    /** Phase 10: timestamp of the last successful Notion sync for this row. */
    last_synced_at: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict();

/**
 * Fields accepted when updating a task mirror row. Every field is optional
 * (partial patch); status transitions are expressed by passing `status`.
 */
export const updateTaskPatchSchema = createTaskInputSchema.partial();

/**
 * Query filters accepted by `listTasks`. `dueBefore`/`dueAfter` are inclusive
 * bounds against `due_date`.
 */
export const taskFiltersSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    dueBefore: isoDate.optional(),
    dueAfter: isoDate.optional(),
    category: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().positive().max(MAX_TASK_LIST_LIMIT).optional(),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskPatch = z.infer<typeof updateTaskPatchSchema>;
export type TaskFilters = z.infer<typeof taskFiltersSchema>;
