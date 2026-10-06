import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from './task';

/**
 * Phase 10/11 — request contract for `POST /api/assistant/actions`.
 *
 * These are the *explicit confirm* actions a user takes on an assistant card.
 * The body is a discriminated union on `action`, so two actions can never be
 * confused. `user_id` is deliberately absent: it always comes from the
 * authenticated request.
 *
 * Phase 11 adds the update family (`update_task`, `complete_task`,
 * `cancel_task`, `delete_task`, `move_task`) and the reminder edits
 * (`update_reminder`, `cancel_reminder`). Mutations only ever run from these
 * confirmed actions — never from the chat message alone.
 */

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour time (HH:mm).');

/** The structured task payload carried by a `create_task` preview card. */
export const actionTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    dueDate: isoDate.nullable().optional(),
    dueTime: clockTime.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    category: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/** The optional reminder payload carried alongside a task. */
export const actionReminderSchema = z
  .object({
    enabled: z.boolean().optional(),
    datetime: z.string().trim().min(1).max(64).nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    before: z.string().trim().max(64).nullable().optional(),
  })
  .strict();

/**
 * The task changes carried by an `update_task` card. Every field is optional;
 * only provided keys are applied. `databaseId` requests a move between Notion
 * databases.
 */
export const taskUpdateChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    dueTime: clockTime.nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    category: z.string().trim().max(120).nullable().optional(),
    databaseId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** `{ action: 'create_task', ... }` — commits the task to Notion + the mirror. */
export const createTaskActionSchema = z
  .object({
    action: z.literal('create_task'),
    task: actionTaskSchema,
    reminder: actionReminderSchema.optional(),
    /** Explicit Notion database choice (from a "which database?" prompt). */
    databaseId: z.string().trim().min(1).max(64).optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'cancel' }` — benign acknowledgement, no writes. */
export const cancelActionSchema = z
  .object({
    action: z.literal('cancel'),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'update_task', taskId, changes }` — applies field changes. */
export const updateTaskActionSchema = z
  .object({
    action: z.literal('update_task'),
    taskId: z.string().trim().min(1).max(64),
    changes: taskUpdateChangesSchema,
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'complete_task', taskId }` — sets the status to `completed`. */
export const completeTaskActionSchema = z
  .object({
    action: z.literal('complete_task'),
    taskId: z.string().trim().min(1).max(64),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'cancel_task', taskId }` — sets the status to `cancelled`. */
export const cancelTaskActionSchema = z
  .object({
    action: z.literal('cancel_task'),
    taskId: z.string().trim().min(1).max(64),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'delete_task', taskId }` — archives + removes the task. */
export const deleteTaskActionSchema = z
  .object({
    action: z.literal('delete_task'),
    taskId: z.string().trim().min(1).max(64),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'move_task', taskId, databaseId }` — moves between databases. */
export const moveTaskActionSchema = z
  .object({
    action: z.literal('move_task'),
    taskId: z.string().trim().min(1).max(64),
    databaseId: z.string().trim().min(1).max(200),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/**
 * `{ action: 'update_reminder', reminderId, scheduledFor? | datetime? | before?, timezone? }`.
 *
 * `before` (e.g. `'1 day'`) is resolved against the related task's deadline;
 * `datetime` and `scheduledFor` are absolute/naive date-times (Phase 13).
 */
export const updateReminderActionSchema = z
  .object({
    action: z.literal('update_reminder'),
    reminderId: z.string().trim().min(1).max(64),
    scheduledFor: z.string().trim().min(1).max(64).optional(),
    datetime: z.string().trim().min(1).max(64).optional(),
    before: z.string().trim().min(1).max(64).optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** `{ action: 'cancel_reminder', reminderId }`. */
export const cancelReminderActionSchema = z
  .object({
    action: z.literal('cancel_reminder'),
    reminderId: z.string().trim().min(1).max(64),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** The button ids a follow-up card can post. */
export const FOLLOW_UP_RESPONSE_VERBS = [
  'completed',
  'mark_completed',
  'in_progress',
  'continue_working',
  'blocked',
  'need_more_time',
  'move_deadline',
] as const;

/**
 * Phase 15 — `{ action: 'follow_up_response', taskId, response, reason? }`.
 * A direct button answer on a follow-up card.
 */
export const followUpResponseActionSchema = z
  .object({
    action: z.literal('follow_up_response'),
    taskId: z.string().trim().min(1).max(64),
    response: z.enum(FOLLOW_UP_RESPONSE_VERBS),
    reason: z.string().trim().min(1).max(500).optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/** Phase 15 — `{ action: 'follow_up_reason', taskId, reason }`. */
export const followUpReasonActionSchema = z
  .object({
    action: z.literal('follow_up_reason'),
    taskId: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(1).max(500),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Phase 15 — `{ action: 'follow_up_new_deadline', taskId, deadline | date | datetime, timezone? }`.
 * The controller requires at least one deadline field (else `400`).
 */
export const followUpNewDeadlineActionSchema = z
  .object({
    action: z.literal('follow_up_new_deadline'),
    taskId: z.string().trim().min(1).max(64),
    deadline: z.string().trim().min(1).max(64).optional(),
    date: isoDate.optional(),
    datetime: z.string().trim().min(1).max(64).optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

export const assistantActionSchema = z.discriminatedUnion('action', [
  createTaskActionSchema,
  cancelActionSchema,
  updateTaskActionSchema,
  completeTaskActionSchema,
  cancelTaskActionSchema,
  deleteTaskActionSchema,
  moveTaskActionSchema,
  updateReminderActionSchema,
  cancelReminderActionSchema,
  followUpResponseActionSchema,
  followUpReasonActionSchema,
  followUpNewDeadlineActionSchema,
]);

export type TaskUpdateChanges = z.infer<typeof taskUpdateChangesSchema>;
export type CreateTaskActionInput = z.infer<typeof createTaskActionSchema>;
export type CancelActionInput = z.infer<typeof cancelActionSchema>;
export type UpdateTaskActionInput = z.infer<typeof updateTaskActionSchema>;
export type CompleteTaskActionInput = z.infer<typeof completeTaskActionSchema>;
export type CancelTaskActionInput = z.infer<typeof cancelTaskActionSchema>;
export type DeleteTaskActionInput = z.infer<typeof deleteTaskActionSchema>;
export type MoveTaskActionInput = z.infer<typeof moveTaskActionSchema>;
export type UpdateReminderActionInput = z.infer<typeof updateReminderActionSchema>;
export type CancelReminderActionInput = z.infer<typeof cancelReminderActionSchema>;
export type FollowUpResponseActionInput = z.infer<typeof followUpResponseActionSchema>;
export type FollowUpReasonActionInput = z.infer<typeof followUpReasonActionSchema>;
export type FollowUpNewDeadlineActionInput = z.infer<typeof followUpNewDeadlineActionSchema>;
export type AssistantActionInput = z.infer<typeof assistantActionSchema>;
