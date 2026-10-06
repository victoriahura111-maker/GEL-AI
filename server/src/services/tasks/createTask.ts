import { z } from 'zod';
import { getDatabaseSchema } from '../notion/schema';
import type { NotionDatabaseSchema } from '../notion/schema';
import { buildNotionProperties, resolvePropertyMapping } from '../notion/propertyMapping';
import { createNotionPage } from '../notion/pages';
import { selectDatabase } from '../notion/databaseSelection';
import type { DatabaseCandidate } from '../notion/databaseSelection';
import { createTaskRecord } from './repository';
import type { TaskRecord } from './repository';
import { createReminder } from '../reminders/repository';
import type { ReminderRecord } from '../reminders/repository';
import { computeScheduledFor } from '../reminders/schedule';
import { writeAuditLog } from '../audit/auditLog';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../validators/task';
import type { CreateTaskInput } from '../../validators/task';

/**
 * Phase 10 — task creation orchestrator.
 *
 * Executes the exact create sequence: validate → resolve database → fetch
 * schema → resolve/buld Notion properties → create the Notion page → persist
 * the local mirror → persist an optional `pending` reminder → append an audit
 * row → return the created references.
 *
 * Failure policy (documented in `docs/assistant.md`):
 *  - If Notion fails, **no** mirror row is written and the typed
 *    {@link NotionApiError} propagates to the caller.
 *  - If the Notion page is created but the mirror write fails, the error is
 *    logged and the created page (with its Notion URL) is still returned —
 *    the URL is never lost. `task` is then `null` and no reminder/audit `task_id`
 *    is available.
 *  - Reminder and audit writes are best-effort and never fail the request.
 *
 * Automatic creation is intentionally NOT performed here; this phase requires an
 * explicit user confirmation (a later phase adds an auto-create setting).
 */

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');

const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour time (HH:mm).');

/** Validated input for {@link createTask} (camelCase, card-friendly). */
export const createTaskServiceInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z.string().trim().max(120).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueDate: isoDate.nullable().optional(),
    dueTime: clockTime.nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
  })
  .strict();

export type CreateTaskServiceInput = z.infer<typeof createTaskServiceInputSchema>;

/** Optional reminder attached to a creation request. */
export interface CreateTaskReminderInput {
  enabled?: boolean;
  datetime?: string | null;
  timezone?: string | null;
  before?: string | null;
  recurrence?: string | null;
}

/** Optional overrides for {@link createTask}. */
export interface CreateTaskOptions {
  /** Explicit Notion database; must belong to the caller (verified via schema fetch). */
  databaseId?: string | null;
  reminder?: CreateTaskReminderInput | null;
}

/** Typed error for invalid orchestrator input (defense-in-depth after Zod). */
export class CreateTaskError extends Error {
  readonly code: 'invalid_input';

  constructor(message: string) {
    super(`[tasks] ${message}`);
    this.name = 'CreateTaskError';
    this.code = 'invalid_input';
  }
}

/** Typed result of {@link createTask}. */
export type CreateTaskResult =
  | {
      status: 'created';
      /** `null` when the Notion page was created but the mirror write failed. */
      task: TaskRecord | null;
      notion: { id: string; url: string | null };
      database: { id: string; title: string };
      reminder?: ReminderRecord;
    }
  | { status: 'needs_database'; candidates: DatabaseCandidate[] }
  | { status: 'no_databases'; candidates: [] };

const FALLBACK_TIMEZONE = 'UTC';

/** Maps the validated service input to the mirror-row input shape (snake_case). */
function toMirrorInput(
  input: CreateTaskServiceInput,
  notion: { id: string; url: string | null },
  databaseId: string,
  nowIso: string
): CreateTaskInput {
  return {
    title: input.title,
    description: input.description ?? null,
    category: input.category ?? null,
    priority: input.priority ?? null,
    status: input.status,
    due_date: input.dueDate ?? null,
    due_time: input.dueTime ?? null,
    timezone: input.timezone ?? null,
    source_of_change: 'assistant',
    sync_status: 'synced',
    notion_page_id: notion.id,
    notion_database_id: databaseId,
    notion_url: notion.url,
    last_synced_at: nowIso,
  };
}

/**
 * Creates a task end-to-end for `userId`.
 *
 * @throws {CreateTaskError} `invalid_input` when the input fails validation.
 * @throws {NotionApiError} when the Notion schema/page call fails (nothing is
 * persisted locally in that case).
 * @throws {PropertyMappingError} when the target database cannot be mapped.
 */
export async function createTask(
  userId: string,
  input: CreateTaskServiceInput,
  options: CreateTaskOptions = {}
): Promise<CreateTaskResult> {
  // (1) Validate input (defense-in-depth on top of the route's validation).
  const parsed = createTaskServiceInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CreateTaskError('The task input is invalid.');
  }
  const data = parsed.data;

  // (2) Resolve the database. An explicit id is verified against the user's own
  //     Notion access (the schema fetch uses their decrypted token), so a
  //     foreign id fails rather than being trusted.
  let schema: NotionDatabaseSchema;
  let databaseId: string;
  let databaseTitle: string;

  if (options.databaseId) {
    schema = await getDatabaseSchema(userId, options.databaseId, { fresh: true });
    databaseId = schema.id;
    databaseTitle = schema.title;
  } else {
    const selection = await selectDatabase(userId, data.category);
    if (selection.status === 'no_databases') {
      // (3) No Notion call is made.
      return { status: 'no_databases', candidates: [] };
    }
    if (selection.status === 'needs_choice') {
      // (3) No Notion call is made.
      return { status: 'needs_database', candidates: selection.candidates };
    }
    databaseId = selection.databaseId;
    databaseTitle = selection.title;
    schema = await getDatabaseSchema(userId, databaseId, { fresh: true });
  }

  // (4) Map the schema once and build the Notion properties payload.
  const mapping = resolvePropertyMapping(schema);
  const properties = buildNotionProperties(mapping, {
    title: data.title,
    description: data.description ?? null,
    category: data.category ?? null,
    priority: data.priority ?? null,
    status: data.status ?? null,
    due_date: data.dueDate ?? null,
    due_time: data.dueTime ?? null,
    timezone: data.timezone ?? null,
  });

  // (5) Create the Notion page. A failure here propagates and nothing is stored.
  const notion = await createNotionPage(userId, databaseId, properties);
  const nowIso = new Date().toISOString();

  // (6) Persist the local mirror. On failure keep the Notion URL and continue.
  let task: TaskRecord | null = null;
  try {
    task = await createTaskRecord(userId, toMirrorInput(data, notion, databaseId, nowIso));
  } catch {
    console.error(
      '[tasks] Notion page created but the local mirror write failed; returning the Notion URL.'
    );
    task = null;
  }

  // (7) Persist an optional `pending` reminder. Phase 13 computes `scheduled_for`
  //     from the reminder intent: `datetime` is an absolute/naive date-time, and
  //     `before` is a relative offset resolved against the task deadline (end of
  //     day when the task has no due time). A reminder needs the mirror row for
  //     its task_id, so it is skipped when the mirror write failed.
  //
  //     `allowPast` is set because the create flow may carry a model-supplied
  //     time that has just passed; the worker delivers it on the next tick. The
  //     explicit reminder API rejects past schedules with a 400 instead.
  let reminder: ReminderRecord | undefined;
  const reminderInput = options.reminder;
  const hasReminderTarget = Boolean(reminderInput?.datetime || reminderInput?.before);
  const reminderEnabled = reminderInput?.enabled !== false && hasReminderTarget;
  if (task && reminderEnabled && reminderInput) {
    try {
      const schedule = computeScheduledFor({
        mode: reminderInput.datetime ? 'at' : 'before',
        datetime: reminderInput.datetime ?? null,
        before: reminderInput.before ?? null,
        deadline: data.dueDate ? { dueDate: data.dueDate, dueTime: data.dueTime ?? null } : null,
        timezone: reminderInput.timezone ?? data.timezone ?? FALLBACK_TIMEZONE,
        allowPast: true,
      });

      reminder =
        (await createReminder(userId, {
          taskId: task.id,
          scheduledFor: schedule.scheduledFor,
          timezone: schedule.timezone,
          channel: 'in_app',
          recurrence: reminderInput.recurrence ?? null,
        })) ?? undefined;
    } catch {
      console.error('[tasks] Could not schedule the reminder for the created task.');
    }
  }

  // (8) Append an audit row (best-effort; never fails the request).
  await writeAuditLog(userId, {
    action: 'task_created',
    taskId: task?.id ?? null,
    notionPageId: notion.id,
    toolName: 'create_task',
    metadata: {
      database_id: databaseId,
      database_title: databaseTitle,
      category: data.category ?? null,
    },
  });

  // (9) Return the created references.
  return {
    status: 'created',
    task,
    notion: { id: notion.id, url: notion.url },
    database: { id: databaseId, title: databaseTitle },
    ...(reminder ? { reminder } : {}),
  };
}

// Re-exported so callers can type-check the mirror input without importing the
// validator module directly.
export type { CreateTaskInput };
