import { getTaskById, updateTaskRecord, deleteTaskRecord } from './repository';
import type { TaskRecord, TaskPriority, TaskStatus } from './repository';
import { getDatabaseSchema } from '../notion/schema';
import { buildNotionProperties, resolvePropertyMapping } from '../notion/propertyMapping';
import type { NotionTaskInput } from '../notion/propertyMapping';
import { createNotionPage, updatePage, archivePage } from '../notion/pages';
import { selectDatabase } from '../notion/databaseSelection';
import { listRemindersForTask, cancelReminder } from '../reminders/repository';
import { writeAuditLog } from '../audit/auditLog';
import { taskUpdateChangesSchema } from '../../validators/assistantAction';
import type { TaskUpdateChanges } from '../../validators/assistantAction';
import type { UpdateTaskPatch } from '../../validators/task';

/**
 * Phase 11 — task update orchestrator.
 *
 * Applies an assistant-driven change to a task: it writes ONLY the changed
 * properties to Notion, then updates the local mirror, then appends an audit
 * row. Supports completed/cancelled status transitions, field edits, moving a
 * task between Notion databases, and deletion (archive + clean up + remove).
 *
 * Failure policy (documented in `docs/assistant.md`):
 *  - If Notion fails, the typed {@link NotionApiError} propagates and the local
 *    mirror is left untouched (no partial local state).
 *  - If the Notion write succeeds but the mirror write fails, the Notion result
 *    is still returned (with a warning) so the change is never silently lost.
 *  - A move creates the replacement page FIRST, then archives the original. If
 *    archiving fails, BOTH pages are kept, the mirror points at the new page,
 *    and a warning explains the situation — user data is never lost.
 *
 * Mutations are only ever performed after an explicit user confirmation (the
 * action route). `userId` always comes from the authenticated request.
 */

/** Typed error for invalid orchestrator input (defense-in-depth after Zod). */
export class UpdateTaskError extends Error {
  readonly code: 'invalid_input';

  constructor(message: string) {
    super(`[tasks] ${message}`);
    this.name = 'UpdateTaskError';
    this.code = 'invalid_input';
  }
}

export type ApplyTaskUpdateResult =
  | {
      status: 'updated';
      /** `null` when Notion succeeded but the mirror write failed. */
      task: TaskRecord | null;
      notion?: { id: string; url: string | null };
      warnings: string[];
    }
  | { status: 'not_found' };

export type DeleteTaskResult =
  | { status: 'deleted'; task: TaskRecord; warnings: string[] }
  | { status: 'not_found' };

const NOT_FOUND_WARNING = 'The task has no linked Notion page, so only the local copy was updated.';

/** Human-facing audit action + tool name for a batch of changes. */
function auditFor(changes: TaskUpdateChanges): {
  action: 'task_updated' | 'task_completed' | 'task_cancelled';
  toolName: 'update_task' | 'complete_task' | 'cancel_task';
} {
  if (changes.status === 'completed') {
    return { action: 'task_completed', toolName: 'complete_task' };
  }
  if (changes.status === 'cancelled') {
    return { action: 'task_cancelled', toolName: 'cancel_task' };
  }
  return { action: 'task_updated', toolName: 'update_task' };
}

/**
 * Applies `changes` to the task owned by `userId`.
 *
 * @throws {UpdateTaskError} `invalid_input` when the changes fail validation.
 * @throws {NotionApiError} when a Notion schema/page call fails (the mirror is
 * left unchanged in that case).
 * @throws {PropertyMappingError} when the target database cannot be mapped.
 */
export async function applyTaskUpdate(
  userId: string,
  taskId: string,
  changes: TaskUpdateChanges
): Promise<ApplyTaskUpdateResult> {
  const parsed = taskUpdateChangesSchema.safeParse(changes);
  if (!parsed.success) {
    throw new UpdateTaskError('The task changes are invalid.');
  }
  const data = parsed.data;

  const task = await getTaskById(userId, taskId);
  if (!task) {
    return { status: 'not_found' };
  }

  // Resolve a move target: an explicit `databaseId`, or a `category` change that
  // maps to a different user database (e.g. "Put this in my personal tasks.").
  let targetDatabaseId = data.databaseId ?? null;
  if (!targetDatabaseId && data.category !== undefined && data.category && data.category !== task.category) {
    try {
      const selection = await selectDatabase(userId, data.category);
      if (selection.status === 'selected' && selection.databaseId !== task.notion_database_id) {
        targetDatabaseId = selection.databaseId;
      }
    } catch {
      // Resolution failure falls back to a plain property update.
      targetDatabaseId = null;
    }
  }

  const isMove = Boolean(targetDatabaseId && targetDatabaseId !== task.notion_database_id);

  // Merged "next" values (used for the Notion date payload and, on move, the
  // full property set).
  const timezone = data.timezone !== undefined ? data.timezone : task.timezone;
  const next = {
    title: data.title ?? task.title,
    description: data.description !== undefined ? data.description : task.description,
    due_date: data.dueDate !== undefined ? data.dueDate : task.due_date,
    due_time: data.dueTime !== undefined ? data.dueTime : task.due_time,
    priority: data.priority !== undefined ? data.priority : task.priority,
    status: data.status ?? task.status,
    category: data.category !== undefined ? data.category : task.category,
  };

  // Mirror patch for changed scalar fields only.
  const mirrorPatch: UpdateTaskPatch = {};
  if (data.title !== undefined && data.title !== task.title) mirrorPatch.title = data.title;
  if (data.description !== undefined && data.description !== task.description) {
    mirrorPatch.description = data.description;
  }
  if (data.dueDate !== undefined && data.dueDate !== task.due_date) mirrorPatch.due_date = data.dueDate;
  if (data.dueTime !== undefined && data.dueTime !== task.due_time) mirrorPatch.due_time = data.dueTime;
  if (timezone !== task.timezone) mirrorPatch.timezone = timezone;
  if (data.priority !== undefined && data.priority !== task.priority) mirrorPatch.priority = data.priority;
  if (data.status !== undefined && data.status !== task.status) mirrorPatch.status = data.status;
  if (data.category !== undefined && data.category !== task.category) mirrorPatch.category = data.category;

  const warnings: string[] = [];
  const nowIso = new Date().toISOString();
  const syncFields: UpdateTaskPatch = {
    source_of_change: 'assistant',
    sync_status: 'synced',
    last_synced_at: nowIso,
  };

  if (isMove && targetDatabaseId) {
    return performMove({
      userId,
      task,
      targetDatabaseId,
      next,
      mirrorPatch,
      syncFields,
      changes: data,
      warnings,
    });
  }

  // --- In-place update -------------------------------------------------------
  const hasFieldChanges = Object.keys(mirrorPatch).length > 0;

  if (hasFieldChanges && task.notion_page_id && task.notion_database_id) {
    const schema = await getDatabaseSchema(userId, task.notion_database_id, { fresh: true });
    const mapping = resolvePropertyMapping(schema);

    // Build ONLY the changed properties.
    const notionInput: NotionTaskInput = {};
    if (mirrorPatch.title !== undefined) notionInput.title = mirrorPatch.title;
    if (mirrorPatch.description !== undefined) notionInput.description = mirrorPatch.description;
    if (mirrorPatch.due_date !== undefined || mirrorPatch.due_time !== undefined) {
      notionInput.due_date = next.due_date;
      notionInput.due_time = next.due_time;
      notionInput.timezone = timezone;
    }
    if (mirrorPatch.priority !== undefined) notionInput.priority = mirrorPatch.priority;
    if (mirrorPatch.status !== undefined) notionInput.status = mirrorPatch.status;
    if (mirrorPatch.category !== undefined) notionInput.category = mirrorPatch.category;

    const properties = buildNotionProperties(mapping, notionInput);

    // Status is silently omitted by the mapping when Notion has no matching
    // status option — surface that rather than letting it fail quietly.
    if (mirrorPatch.status !== undefined) {
      const statusProperty = mapping.status;
      if (!statusProperty) {
        warnings.push('The Notion database has no status property; the status was only updated locally.');
      } else if (properties[statusProperty] === undefined) {
        warnings.push(
          `Notion has no status option for "${mirrorPatch.status}"; the status was only updated locally.`
        );
      }
    }

    if (Object.keys(properties).length > 0) {
      // A Notion failure here propagates and leaves the mirror unchanged.
      await updatePage(userId, task.notion_page_id, properties);
    } else {
      warnings.push('Nothing needed to be written to Notion.');
    }
  } else if (hasFieldChanges) {
    warnings.push(NOT_FOUND_WARNING);
  }

  let updated: TaskRecord | null = task;
  try {
    updated = await updateTaskRecord(userId, taskId, { ...mirrorPatch, ...syncFields });
  } catch {
    console.error('[tasks] The task was updated in Notion but the local mirror write failed.');
    warnings.push('The change reached Notion but the local copy could not be updated.');
    updated = null;
  }

  const audit = auditFor(data);
  await writeAuditLog(userId, {
    action: audit.action,
    taskId,
    notionPageId: task.notion_page_id,
    toolName: audit.toolName,
    metadata: {
      changed_fields: Object.keys(mirrorPatch),
      ...(mirrorPatch.status ? { status: mirrorPatch.status } : {}),
    },
  });

  return {
    status: 'updated',
    task: updated,
    ...(task.notion_page_id && task.notion_url
      ? { notion: { id: task.notion_page_id, url: task.notion_url } }
      : {}),
    warnings,
  };
}

interface MoveParams {
  userId: string;
  task: TaskRecord;
  targetDatabaseId: string;
  next: {
    title: string;
    description: string | null;
    due_date: string | null;
    due_time: string | null;
    priority: TaskPriority | null;
    status: TaskStatus;
    category: string | null;
  };
  mirrorPatch: UpdateTaskPatch;
  syncFields: UpdateTaskPatch;
  changes: TaskUpdateChanges;
  warnings: string[];
}

/** Creates the page in the target database, archives the original, updates the mirror. */
async function performMove(params: MoveParams): Promise<ApplyTaskUpdateResult> {
  const { userId, task, targetDatabaseId, next, mirrorPatch, syncFields, changes, warnings } = params;

  const schema = await getDatabaseSchema(userId, targetDatabaseId, { fresh: true });
  const mapping = resolvePropertyMapping(schema);

  const properties = buildNotionProperties(mapping, {
    title: next.title,
    description: next.description,
    category: next.category,
    priority: next.priority,
    status: next.status,
    due_date: next.due_date,
    due_time: next.due_time,
    timezone: task.timezone,
    notion_url: task.notion_url,
  });

  // 1) Create the replacement page FIRST. A failure here leaves everything as-is.
  const created = await createNotionPage(userId, schema.id, properties);

  // 2) Archive the original page. A failure keeps BOTH pages (never lose data).
  if (task.notion_page_id) {
    try {
      await archivePage(userId, task.notion_page_id);
    } catch {
      warnings.push(
        'The task was recreated in the new database, but the original page could not be archived — both pages now exist.'
      );
    }
  }

  // 3) Point the mirror at the new page and apply any other field changes.
  const moveFields: UpdateTaskPatch = {
    ...mirrorPatch,
    notion_page_id: created.id,
    notion_database_id: schema.id,
    notion_url: created.url,
    ...syncFields,
  };

  let updated: TaskRecord | null = task;
  try {
    updated = await updateTaskRecord(userId, task.id, moveFields);
  } catch {
    console.error('[tasks] The task was moved in Notion but the local mirror write failed.');
    warnings.push('The task was moved in Notion but the local copy could not be updated.');
    updated = null;
  }

  await writeAuditLog(userId, {
    action: 'task_moved',
    taskId: task.id,
    notionPageId: created.id,
    toolName: 'move_task',
    metadata: {
      from_database_id: task.notion_database_id,
      to_database_id: schema.id,
      original_page_id: task.notion_page_id,
      changed_fields: Object.keys(mirrorPatch),
      ...(changes.databaseId ? { explicit_database_id: changes.databaseId } : {}),
    },
  });

  return {
    status: 'updated',
    task: updated,
    notion: { id: created.id, url: created.url },
    warnings,
  };
}

/**
 * Deletes a task: archives the Notion page (when present), cancels pending
 * reminders, then removes the local mirror row. A Notion failure propagates and
 * the mirror is preserved so no data is lost.
 *
 * @throws {NotionApiError} when archiving the Notion page fails.
 */
export async function deleteTask(userId: string, taskId: string): Promise<DeleteTaskResult> {
  const task = await getTaskById(userId, taskId);
  if (!task) {
    return { status: 'not_found' };
  }

  const warnings: string[] = [];

  if (task.notion_page_id) {
    // Archive, not hard-delete, so the page remains recoverable in Notion trash.
    await archivePage(userId, task.notion_page_id);
  }

  try {
    const reminders = await listRemindersForTask(userId, taskId);
    for (const reminder of reminders) {
      if (reminder.status === 'pending') {
        await cancelReminder(userId, reminder.id);
      }
    }
  } catch {
    console.error('[tasks] Could not cancel reminders for a deleted task.');
    warnings.push('The task was deleted, but some reminders could not be cancelled.');
  }

  await deleteTaskRecord(userId, taskId);

  await writeAuditLog(userId, {
    action: 'task_deleted',
    taskId,
    notionPageId: task.notion_page_id,
    toolName: 'delete_task',
    metadata: { title: task.title },
  });

  return { status: 'deleted', task, warnings };
}
