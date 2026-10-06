import { z } from 'zod';

/**
 * The full intent set the assistant can understand. Used both to build the
 * extraction prompt and to validate the model's structured output.
 */
export const INTENT_NAMES = [
  'create_task',
  'update_task',
  'complete_task',
  'cancel_task',
  'delete_task',
  'postpone_task',
  'reschedule_task',
  'search_tasks',
  'list_tasks',
  'get_task',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'check_task_status',
  'clarify',
  'general',
] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

// --- Shared primitives -------------------------------------------------------

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const isoDateTime = z.string().trim().min(1);

const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour time (HH:mm).');

const priority = z.enum(['low', 'medium', 'high']);

const reply = z.string().trim().min(1).max(2000);
const confidence = z.number().min(0).max(1);

const title = z.string().trim().min(1).max(300);
const taskIdentifier = z.string().trim().min(1).max(300);
const category = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000);
const before = z.string().trim().min(1).max(64);

// --- Payload pieces ----------------------------------------------------------

/** The optional reminder attached to a `create_task` intent. */
const reminderSettingsSchema = z
  .object({
    enabled: z.boolean(),
    datetime: isoDateTime.nullable(),
    timezone: z.string().trim().min(1).max(64),
    before: before.nullable(),
  })
  .strict();

/** A task draft (used by `create_task`). Unknown/unspecified fields are null. */
const taskDraftSchema = z
  .object({
    title,
    due_date: isoDate.nullable(),
    due_time: clockTime.nullable(),
    priority: priority.nullable(),
    category: category.nullable(),
    description: description.nullable(),
  })
  .strict();

/** A reminder draft (used by `create_reminder`). */
const reminderDraftSchema = z
  .object({
    title,
    datetime: isoDateTime.nullable(),
    timezone: z.string().trim().min(1).max(64),
    before: before.nullable(),
    description: description.nullable().optional(),
  })
  .strict();

const taskChangesSchema = z
  .object({
    title: title.nullable(),
    due_date: isoDate.nullable(),
    due_time: clockTime.nullable(),
    priority: priority.nullable(),
    category: category.nullable(),
    description: description.nullable(),
  })
  .partial()
  .strict();

const reminderChangesSchema = z
  .object({
    title: title.nullable(),
    datetime: isoDateTime.nullable(),
    timezone: z.string().trim().min(1).max(64).nullable(),
    before: before.nullable(),
  })
  .partial()
  .strict();

// --- Intents -----------------------------------------------------------------

const createTaskIntent = z
  .object({
    intent: z.literal('create_task'),
    reply,
    confidence,
    task: taskDraftSchema,
    reminder: reminderSettingsSchema.optional(),
  })
  .strict();

const updateTaskIntent = z
  .object({
    intent: z.literal('update_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const completeTaskIntent = z
  .object({
    intent: z.literal('complete_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const cancelTaskIntent = z
  .object({
    intent: z.literal('cancel_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const deleteTaskIntent = z
  .object({
    intent: z.literal('delete_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const postponeTaskIntent = z
  .object({
    intent: z.literal('postpone_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const rescheduleTaskIntent = z
  .object({
    intent: z.literal('reschedule_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
    changes: taskChangesSchema.optional(),
  })
  .strict();

const searchTasksIntent = z
  .object({
    intent: z.literal('search_tasks'),
    reply,
    confidence,
    query: z.string().trim().min(1).max(300).nullable(),
    status: z.enum(['open', 'completed', 'cancelled']).nullable().optional(),
    category: category.nullable().optional(),
  })
  .strict();

const listTasksIntent = z
  .object({
    intent: z.literal('list_tasks'),
    reply,
    confidence,
    scope: z.enum(['all', 'today', 'upcoming', 'overdue']).nullable(),
    category: category.nullable(),
  })
  .strict();

const getTaskIntent = z
  .object({
    intent: z.literal('get_task'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
  })
  .strict();

const createReminderIntent = z
  .object({
    intent: z.literal('create_reminder'),
    reply,
    confidence,
    reminder: reminderDraftSchema,
  })
  .strict();

const updateReminderIntent = z
  .object({
    intent: z.literal('update_reminder'),
    reply,
    confidence,
    reminder_identifier: taskIdentifier,
    changes: reminderChangesSchema.optional(),
  })
  .strict();

const cancelReminderIntent = z
  .object({
    intent: z.literal('cancel_reminder'),
    reply,
    confidence,
    reminder_identifier: taskIdentifier,
  })
  .strict();

const checkTaskStatusIntent = z
  .object({
    intent: z.literal('check_task_status'),
    reply,
    confidence,
    task_identifier: taskIdentifier,
  })
  .strict();

const clarifyIntent = z
  .object({
    intent: z.literal('clarify'),
    reply,
    confidence,
    message: z.string().trim().min(1).max(2000),
    missing_information: z.array(z.string().trim().min(1).max(120)).max(20),
  })
  .strict();

const generalIntent = z
  .object({
    intent: z.literal('general'),
    reply,
    confidence,
  })
  .strict();

/**
 * Strict discriminated union describing every valid assistant intent. Model
 * output that does not match this schema is rejected (and retried once).
 */
export const intentSchema = z.discriminatedUnion('intent', [
  createTaskIntent,
  updateTaskIntent,
  completeTaskIntent,
  cancelTaskIntent,
  deleteTaskIntent,
  postponeTaskIntent,
  rescheduleTaskIntent,
  searchTasksIntent,
  listTasksIntent,
  getTaskIntent,
  createReminderIntent,
  updateReminderIntent,
  cancelReminderIntent,
  checkTaskStatusIntent,
  clarifyIntent,
  generalIntent,
]);

export type Intent = z.infer<typeof intentSchema>;
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export type ReminderDraft = z.infer<typeof reminderDraftSchema>;
export type CreateTaskIntent = z.infer<typeof createTaskIntent>;
export type CreateReminderIntent = z.infer<typeof createReminderIntent>;
export type ClarifyIntent = z.infer<typeof clarifyIntent>;
