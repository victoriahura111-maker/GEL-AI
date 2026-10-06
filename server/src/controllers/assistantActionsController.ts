import type { Request, Response } from 'express';
import { assistantActionSchema } from '../validators/assistantAction';
import type {
  UpdateTaskActionInput,
  CompleteTaskActionInput,
  CancelTaskActionInput,
  MoveTaskActionInput,
} from '../validators/assistantAction';
import { createTask, CreateTaskError } from '../services/tasks/createTask';
import type { CreateTaskServiceInput } from '../services/tasks/createTask';
import { applyTaskUpdate, deleteTask, UpdateTaskError } from '../services/tasks/updateTask';
import type { ApplyTaskUpdateResult } from '../services/tasks/updateTask';
import {
  cancelReminder,
  getReminderById,
  updateReminder,
} from '../services/reminders/repository';
import { computeScheduledFor, ReminderScheduleError } from '../services/reminders/schedule';
import { getTaskById } from '../services/tasks/repository';
import { handleFollowUpResponse } from '../services/followup';
import type { HandleFollowUpResponseInput } from '../services/followup';
import type {
  FollowUpResponseActionInput,
  FollowUpReasonActionInput,
  FollowUpNewDeadlineActionInput,
} from '../validators/assistantAction';
import { NotionApiError } from '../services/notion/client';
import { PropertyMappingError } from '../services/notion/propertyMapping';
import { appendMessage, getOrCreateConversation } from '../services/conversations';
import type { ConversationRecord } from '../services/conversations';
import type {
  AssistantCard,
  ConfirmationCard,
  TaskCard,
  TaskCardPayload,
} from '../services/ai/toCards';

/**
 * Phase 10/11 — explicit card action endpoint (`POST /api/assistant/actions`).
 *
 * The assistant never mutates data on its own: every write happens only when the
 * user explicitly confirms a card. This controller:
 *  - validates the action body (discriminated union on `action`),
 *  - for `create_task`, calls the creation orchestrator,
 *  - for the update family (`update_task`, `complete_task`, `cancel_task`,
 *    `delete_task`, `move_task`), calls the update orchestrator,
 *  - for `update_reminder` / `cancel_reminder`, edits the reminder row,
 *  - persists an assistant confirmation message,
 *  - and returns only user-safe output.
 *
 * Ownership is enforced by every repository (all queries filter on `user_id`);
 * a foreign task/reminder resolves to "not found".
 */

interface PublicError {
  status: number;
  message: string;
}

/** Maps a typed Notion client error to a public status + message. */
function mapNotionError(error: unknown): PublicError | null {
  if (!(error instanceof NotionApiError)) return null;

  switch (error.code) {
    case 'not_connected':
      return { status: 409, message: 'Connect Notion first' };
    case 'unauthorized':
    case 'forbidden':
      return { status: 409, message: 'Reconnect Notion to continue' };
    case 'not_found':
      return { status: 404, message: error.message };
    case 'rate_limited':
      return { status: 429, message: error.message };
    case 'network_error':
    case 'invalid_response':
    case 'api_error':
    default:
      return { status: 502, message: error.message };
  }
}

/** Formats a due date+time into the human line used in the confirmation text. */
function formatDue(payload: TaskCardPayload): string | null {
  if (!payload.dueDate) return null;
  return payload.dueTime ? `${payload.dueDate} at ${payload.dueTime}` : payload.dueDate;
}

/** Builds the product-example confirmation: "✓ Task created — ...". */
function buildConfirmationMessage(
  title: string,
  dueText: string | null,
  databaseTitle: string,
  reminderText: string | null
): string {
  const parts = [`✓ Task created — ${title}`];
  if (dueText) parts.push(`Due: ${dueText}`);
  parts.push(`Database: ${databaseTitle}`);
  if (reminderText) parts.push(`Reminder: ${reminderText}`);
  return parts.join(', ');
}

/** Builds the post-update card (shown when a Notion URL is available). */
function buildResultCard(title: string, notionUrl: string | null): TaskCard | null {
  if (!notionUrl) return null;
  return {
    type: 'task',
    title,
    notionUrl,
    actions: [],
  };
}

/**
 * Resolves the caller's conversation (best-effort). A persistence hiccup must
 * never break the user's action, so failures yield `null`.
 */
async function resolveConversation(
  userId: string,
  conversationId?: string
): Promise<ConversationRecord | null> {
  try {
    return await getOrCreateConversation(userId, conversationId);
  } catch {
    console.error('[assistant] Could not resolve a conversation for an action.');
    return null;
  }
}

/** Persists the assistant confirmation message (best-effort). */
async function persistAssistantMessage(
  userId: string,
  conversation: ConversationRecord | null,
  content: string,
  cards: AssistantCard[] | null
): Promise<void> {
  if (!conversation) return;
  try {
    await appendMessage(userId, conversation.id, {
      role: 'assistant',
      content,
      cards: cards ?? null,
    });
  } catch {
    console.error('[assistant] Could not persist the action confirmation message.');
  }
}

/** Responds with a persisted confirmation message and the mutation result. */
async function respondWithResult(
  res: Response,
  userId: string,
  conversationId: string | undefined,
  content: string,
  result: {
    task?: unknown;
    notionUrl?: string | null;
    warnings?: string[];
    title?: string;
  }
): Promise<void> {
  const conversation = await resolveConversation(userId, conversationId);
  const card = result.notionUrl ? buildResultCard(result.title ?? 'Task', result.notionUrl) : null;
  const cards = card ? [card] : null;
  await persistAssistantMessage(userId, conversation, content, cards);

  res.status(200).json({
    message: { role: 'assistant', content, ...(cards ? { cards } : {}) },
    ...(conversation ? { conversationId: conversation.id } : {}),
    ...(result.task ? { task: result.task } : {}),
    ...(result.notionUrl ? { notionUrl: result.notionUrl } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  });
}

/** The update-family actions handled by {@link handleTaskUpdateAction}. */
type TaskUpdateActionInput =
  | UpdateTaskActionInput
  | CompleteTaskActionInput
  | CancelTaskActionInput
  | MoveTaskActionInput;

/** Runs an update-family action and builds its confirmation message. */
async function handleTaskUpdateAction(
  userId: string,
  action: TaskUpdateActionInput,
  res: Response
): Promise<void> {
  let changes: Parameters<typeof applyTaskUpdate>[2];
  let verb: string;

  switch (action.action) {
    case 'complete_task':
      changes = { status: 'completed' };
      verb = 'marked as completed';
      break;
    case 'cancel_task':
      changes = { status: 'cancelled' };
      verb = 'cancelled';
      break;
    case 'move_task':
      changes = { databaseId: action.databaseId };
      verb = 'moved to the new database';
      break;
    case 'update_task':
    default:
      changes = action.changes;
      verb = 'updated';
      break;
  }

  const result: ApplyTaskUpdateResult = await applyTaskUpdate(userId, action.taskId, changes);

  if (result.status === 'not_found') {
    res.status(404).json({ error: 'I could not find that task.' });
    return;
  }

  const title = result.task?.title ?? 'the task';
  const warnings = result.warnings;
  let content = `Done. I've ${verb} ${title}.`;
  if (warnings.length > 0) {
    content = `${content} Note: ${warnings.join(' ')}`;
  }

  await respondWithResult(res, userId, action.conversationId, content, {
    task: result.task ?? undefined,
    notionUrl: result.notion?.url ?? null,
    warnings,
    title,
  });
}

/** The Phase 15 follow-up actions. */
type FollowUpActionInput =
  | FollowUpResponseActionInput
  | FollowUpReasonActionInput
  | FollowUpNewDeadlineActionInput;

/**
 * Phase 15 — runs a follow-up response and returns the standard action reply.
 * `follow_up_reason` is sugar for a `blocked` response carrying a reason;
 * `follow_up_new_deadline` maps to the reschedule verb.
 */
async function handleFollowUpAction(
  userId: string,
  action: FollowUpActionInput,
  res: Response
): Promise<void> {
  let input: HandleFollowUpResponseInput;

  if (action.action === 'follow_up_reason') {
    input = { taskId: action.taskId, response: 'blocked', reason: action.reason };
  } else if (action.action === 'follow_up_new_deadline') {
    const deadline = action.deadline ?? action.datetime ?? action.date;
    if (!deadline) {
      res.status(400).json({ error: 'A new deadline is required.' });
      return;
    }
    input = {
      taskId: action.taskId,
      response: 'move_deadline',
      newDeadline: deadline,
      timezone: action.timezone ?? null,
    };
  } else {
    input = { taskId: action.taskId, response: action.response, reason: action.reason };
  }

  const result = await handleFollowUpResponse(userId, input);

  if (result.status === 'not_found') {
    res.status(404).json({ error: 'I could not find that task.' });
    return;
  }

  if (result.status === 'invalid_deadline') {
    res.status(400).json({ error: result.message });
    return;
  }

  // `ok` and `needs_deadline` both return a normal assistant reply.
  await respondWithResult(res, userId, action.conversationId, result.message, {
    task: result.status === 'ok' ? result.task ?? undefined : undefined,
    notionUrl: result.status === 'ok' ? result.notionUrl : null,
    title: result.status === 'ok' ? result.task?.title ?? 'Task' : 'Task',
  });
}

/**
 * `POST /api/assistant/actions`
 *
 * Body is a discriminated union over every confirmable action.
 */
export async function postAssistantAction(req: Request, res: Response): Promise<void> {
  const parsed = assistantActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid action request',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const action = parsed.data;

  try {
    // `cancel` is a benign acknowledgement with no writes.
    if (action.action === 'cancel') {
      const conversation = await resolveConversation(userId, action.conversationId);
      const content = "No problem — I haven't changed anything.";
      await persistAssistantMessage(userId, conversation, content, null);
      res.status(200).json({
        message: { role: 'assistant', content },
        ...(conversation ? { conversationId: conversation.id } : {}),
      });
      return;
    }

    // Update family.
    if (
      action.action === 'update_task' ||
      action.action === 'complete_task' ||
      action.action === 'cancel_task' ||
      action.action === 'move_task'
    ) {
      await handleTaskUpdateAction(userId, action, res);
      return;
    }

    // Delete.
    if (action.action === 'delete_task') {
      const result = await deleteTask(userId, action.taskId);
      if (result.status === 'not_found') {
        res.status(404).json({ error: 'I could not find that task.' });
        return;
      }
      const title = result.task.title;
      const warnings = result.warnings;
      let content = `Done. I've deleted ${title}.`;
      if (warnings.length > 0) content = `${content} Note: ${warnings.join(' ')}`;
      await respondWithResult(res, userId, action.conversationId, content, {
        task: result.task,
        notionUrl: null,
        warnings,
        title,
      });
      return;
    }

    // Reminder edits.
    if (action.action === 'update_reminder') {
      let scheduledFor = action.scheduledFor;
      let timezone = action.timezone;

      // Phase 13 — resolve a relative `before` (or a naive `datetime`) against
      // the related task's deadline before writing.
      const needsResolution =
        scheduledFor === undefined &&
        (action.datetime !== undefined || action.before !== undefined);

      if (needsResolution) {
        const reminder = await getReminderById(userId, action.reminderId);
        if (!reminder) {
          res.status(404).json({ error: 'I could not find that reminder.' });
          return;
        }

        const task = await getTaskById(userId, reminder.task_id);
        if (!task) {
          res.status(400).json({ error: 'The related task is unavailable.' });
          return;
        }

        try {
          const schedule = computeScheduledFor({
            mode: action.datetime ? 'at' : 'before',
            datetime: action.datetime ?? null,
            before: action.before ?? null,
            deadline: task.due_date
              ? { dueDate: task.due_date, dueTime: task.due_time }
              : null,
            timezone: action.timezone ?? reminder.timezone,
          });
          scheduledFor = schedule.scheduledFor;
          timezone = schedule.timezone;
        } catch (error) {
          if (error instanceof ReminderScheduleError) {
            res.status(400).json({ error: 'That reminder time is not valid.' });
            return;
          }
          throw error;
        }
      }

      const updated = await updateReminder(userId, action.reminderId, {
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
      });

      if (!updated) {
        res.status(404).json({ error: 'I could not find that reminder.' });
        return;
      }

      const warnings: string[] = [];
      const hasTimeInput =
        action.scheduledFor !== undefined ||
        action.datetime !== undefined ||
        action.before !== undefined;
      const hasTimeZone = action.timezone !== undefined && action.timezone !== null;
      if (!hasTimeInput && !hasTimeZone) {
        warnings.push('No new reminder time was provided, so nothing changed.');
      }
      let content = "Done. I've updated the reminder.";
      if (warnings.length > 0) content = `${content} Note: ${warnings.join(' ')}`;

      await respondWithResult(res, userId, action.conversationId, content, { warnings });
      return;
    }

    if (action.action === 'cancel_reminder') {
      const cancelled = await cancelReminder(userId, action.reminderId);
      if (!cancelled) {
        res.status(404).json({ error: 'I could not find that reminder.' });
        return;
      }
      await respondWithResult(res, userId, action.conversationId, "Done. I've cancelled the reminder.", {});
      return;
    }

    // Phase 15 — follow-up responses (button/card path).
    if (
      action.action === 'follow_up_response' ||
      action.action === 'follow_up_reason' ||
      action.action === 'follow_up_new_deadline'
    ) {
      await handleFollowUpAction(userId, action, res);
      return;
    }

    // `create_task`
    const { task, reminder, databaseId, conversationId } = action;
    const serviceInput: CreateTaskServiceInput = {
      title: task.title,
      description: task.description ?? null,
      category: task.category ?? null,
      priority: task.priority ?? null,
      dueDate: task.dueDate ?? null,
      dueTime: task.dueTime ?? null,
    };

    const result = await createTask(userId, serviceInput, {
      databaseId: databaseId ?? null,
      reminder: reminder ?? null,
    });

    const conversation = await resolveConversation(userId, conversationId);

    // "Which database?" — ask conversationally, no Notion call was made.
    if (result.status === 'needs_database' || result.status === 'no_databases') {
      const hasCandidates = result.status === 'needs_database';
      const content = hasCandidates
        ? 'Which database should I use for this task?'
        : 'I could not find a Notion database for this task. Connect Notion or map a database first.';

      const choiceCard: ConfirmationCard = {
        type: 'confirmation',
        prompt: content,
        actions: ['cancel'],
        ...(hasCandidates ? { candidates: result.candidates } : {}),
        task,
        ...(reminder ? { reminder } : {}),
      };

      await persistAssistantMessage(userId, conversation, content, [choiceCard]);

      res.status(200).json({
        message: { role: 'assistant', content, cards: [choiceCard] },
        ...(conversation ? { conversationId: conversation.id } : {}),
        needsDatabase: true,
        candidates: hasCandidates ? result.candidates : [],
      });
      return;
    }

    // Success.
    const title = result.task?.title ?? task.title;
    const databaseTitle = result.database.title;
    const content = buildConfirmationMessage(
      title,
      formatDue(task),
      databaseTitle,
      reminder?.datetime ?? null
    );

    const card: TaskCard = {
      type: 'task',
      title,
      database: { id: result.database.id, title: result.database.title },
      task,
      ...(reminder ? { reminder } : {}),
      ...(result.notion.url ? { notionUrl: result.notion.url } : {}),
      actions: [],
    };

    await persistAssistantMessage(userId, conversation, content, [card]);

    res.status(200).json({
      message: { role: 'assistant', content, cards: [card] },
      ...(conversation ? { conversationId: conversation.id } : {}),
      task: result.task,
      notionUrl: result.notion.url,
      database: result.database,
      ...(result.reminder ? { reminder: result.reminder } : {}),
    });
  } catch (error) {
    const notion = mapNotionError(error);
    if (notion) {
      res.status(notion.status).json({ error: notion.message });
      return;
    }

    if (error instanceof PropertyMappingError) {
      res.status(422).json({ error: error.message });
      return;
    }

    if (error instanceof CreateTaskError || error instanceof UpdateTaskError) {
      res.status(400).json({ error: 'Invalid task details' });
      return;
    }

    console.error('[assistant] Unexpected error while performing a card action.');
    res.status(502).json({ error: "I couldn't complete that action right now. Please try again." });
  }
}
