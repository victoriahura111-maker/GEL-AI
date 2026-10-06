import type {
  CreateReminderIntent,
  CreateTaskIntent,
  Intent,
  TaskDraft,
} from '../../validators/intent';

/**
 * Server-side mirror of the card union in `client/src/types/assistant.ts`.
 *
 * The server cannot import client code, so these interfaces duplicate the wire
 * contract. If the client union changes, update both in lockstep — the
 * `assistantRoute` test asserts the emitted shape.
 *
 * Phase 10 extends the task card with the structured, confirm-ready payload
 * (`task`, `reminder`, resolved `database`) and an optional `notionUrl`. All new
 * fields are optional so previously-created messages still render.
 */

export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskAction = 'create' | 'edit' | 'cancel';
export type ReminderAction = 'set' | 'cancel';
export type ConfirmationAction = 'confirm' | 'cancel';
export type TaskUpdateAction = 'confirm' | 'cancel';
/** Which `POST /api/assistant/actions` action a `task_update`/`task_select` confirm maps to. */
export type TaskUpdateActionName =
  | 'update_task'
  | 'complete_task'
  | 'cancel_task'
  | 'delete_task'
  | 'move_task';

/** Structured task fields required to confirm a creation. */
export interface TaskCardPayload {
  title: string;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: TaskPriority | null;
  category?: string | null;
  description?: string | null;
}

/** Optional reminder attached to a task card. */
export interface CardReminderPayload {
  enabled?: boolean;
  datetime?: string | null;
  timezone?: string | null;
  before?: string | null;
}

/** A resolved Notion database reference. */
export interface DatabaseRef {
  id: string;
  title: string;
}

/** A selectable database candidate for the "which database?" flow. */
export interface DatabaseCandidate {
  databaseId: string;
  title: string;
  purpose: string | null;
  isDefault: boolean;
}

export interface TaskCard {
  type: 'task';
  title: string;
  due?: string;
  dueDate?: string;
  priority?: TaskPriority;
  /** The resolved Notion database (Phase 10), or `null` when unresolved. */
  database?: DatabaseRef | null;
  /** Confirm-ready task payload. */
  task?: TaskCardPayload;
  /** Optional reminder payload. */
  reminder?: CardReminderPayload;
  /** Present on the post-creation confirmation card. */
  notionUrl?: string;
  actions: TaskAction[];
}

export interface ReminderCard {
  type: 'reminder';
  title: string;
  time: string;
  description?: string;
  actions: ReminderAction[];
}

export interface ConfirmationCard {
  type: 'confirmation';
  prompt: string;
  actions: ConfirmationAction[];
  /** Candidate databases the user can pick from. */
  candidates?: DatabaseCandidate[];
  /** The task payload carried through the choice so the pick can confirm it. */
  task?: TaskCardPayload;
  reminder?: CardReminderPayload;
}

/**
 * Phase 11 — a proposed task change awaiting confirmation. Carries the
 * structured `taskId` + `changes` so confirming never re-parses free text.
 * `action` selects the concrete action endpoint to POST.
 */
export interface TaskUpdateCard {
  type: 'task_update';
  /** Human-readable summary, e.g. "Move the deadline to 2026-10-06". */
  change: string;
  changeType?: 'complete' | 'cancel' | 'delete' | 'reschedule' | 'postpone' | 'update' | 'move';
  /** The target task's title. */
  targetTask: string;
  taskId: string;
  changes: Record<string, unknown>;
  action: TaskUpdateActionName;
  actions: TaskUpdateAction[];
}

/** One selectable task candidate for the disambiguation flow. */
export interface TaskSelectCandidate {
  taskId: string;
  title: string;
  dueDate?: string;
  database?: string;
}

/**
 * Phase 11 — the "which one do you mean?" card. Selecting a candidate confirms
 * the carried change (`action` + `changes`) for that specific task.
 */
export interface TaskSelectCard {
  type: 'task_select';
  prompt: string;
  candidates: TaskSelectCandidate[];
  /** The action to POST when a candidate is picked. */
  action?: TaskUpdateActionName;
  changes?: Record<string, unknown>;
  actions: TaskUpdateAction[];
}

/** Phase 15 — which follow-up prompt a card represents. */
export type FollowUpKind = 'due_soon' | 'overdue';

/** The typed button ids a `follow_up` card can carry. */
export type FollowUpActionId =
  | 'completed'
  | 'in_progress'
  | 'blocked'
  | 'need_more_time'
  | 'mark_completed'
  | 'continue_working'
  | 'move_deadline';

/**
 * Phase 15 — an interactive follow-up prompt rendered in the assistant chat.
 * `kind` selects the button set: a `due_soon` card offers progress updates, an
 * `overdue` card offers completion / continuation / rescheduling.
 */
export interface FollowUpCard {
  type: 'follow_up';
  kind: FollowUpKind;
  taskId: string;
  taskTitle: string;
  /** Human deadline phrase, e.g. "tomorrow" or "3 days ago". */
  dueLabel: string;
  prompt: string;
  actions: FollowUpActionId[];
}

export type AssistantCard =
  | TaskCard
  | ReminderCard
  | ConfirmationCard
  | TaskUpdateCard
  | TaskSelectCard
  | FollowUpCard;

function formatDue(dueDate: string | null, dueTime: string | null): string | undefined {
  if (!dueDate) return undefined;
  if (!dueTime) return dueDate;
  return `${dueDate} at ${dueTime}`;
}

/** Maps a task draft to the structured card payload. */
export function toTaskCardPayload(task: TaskDraft): TaskCardPayload {
  return {
    title: task.title,
    dueDate: task.due_date,
    dueTime: task.due_time,
    priority: task.priority,
    category: task.category,
    description: task.description,
  };
}

/** Maps the intent's reminder settings to the card reminder payload. */
function toReminderPayload(intent: CreateTaskIntent): CardReminderPayload | undefined {
  const reminder = intent.reminder;
  if (!reminder || reminder.enabled === false) return undefined;
  return {
    enabled: reminder.enabled,
    datetime: reminder.datetime,
    timezone: reminder.timezone,
    before: reminder.before,
  };
}

/**
 * Maps a fully-populated `create_task` intent to a client `task` card.
 * The schema already guarantees `title` is present and non-empty.
 *
 * The resolved `database` is intentionally left unset here; the controller
 * enriches the card via {@link ../notion/databaseSelection.selectDatabase}.
 */
export function createTaskIntentToCard(intent: CreateTaskIntent): TaskCard {
  const card: TaskCard = {
    type: 'task',
    title: intent.task.title,
    task: toTaskCardPayload(intent.task),
    actions: ['create', 'edit', 'cancel'],
  };

  const due = formatDue(intent.task.due_date, intent.task.due_time);
  if (due) {
    card.due = due;
  }

  if (intent.task.due_date) {
    card.dueDate = intent.task.due_time
      ? `${intent.task.due_date}T${intent.task.due_time}:00`
      : intent.task.due_date;
  }

  if (intent.task.priority) {
    card.priority = intent.task.priority;
  }

  const reminder = toReminderPayload(intent);
  if (reminder) {
    card.reminder = reminder;
  }

  return card;
}

/**
 * Builds a `confirmation` card listing candidate databases, carrying the task
 * payload so the user's pick can confirm creation directly. Used for the
 * "Which database should I use?" flow.
 */
export function createDatabaseChoiceCard(
  intent: CreateTaskIntent,
  candidates: DatabaseCandidate[]
): ConfirmationCard {
  return {
    type: 'confirmation',
    prompt: 'Which database should I use for this task?',
    actions: ['confirm', 'cancel'],
    candidates,
    task: toTaskCardPayload(intent.task),
    ...(toReminderPayload(intent) ? { reminder: toReminderPayload(intent) } : {}),
  };
}

/**
 * Maps a `create_reminder` intent to a client `reminder` card, or `null` when
 * the schedule is missing (in which case the caller should have received a
 * `clarify` intent, and no card is emitted).
 */
export function createReminderIntentToCard(intent: CreateReminderIntent): ReminderCard | null {
  const { reminder } = intent;
  if (!reminder.datetime) {
    return null;
  }

  const card: ReminderCard = {
    type: 'reminder',
    title: reminder.title,
    time: reminder.datetime,
    actions: ['set', 'cancel'],
  };

  if (reminder.before) {
    card.description = `${reminder.before} before`;
  } else if (reminder.description) {
    card.description = reminder.description;
  }

  return card;
}

/**
 * Converts a validated intent into zero or more client cards. Only intents with
 * a fully-specified, renderable payload produce cards; everything else (including
 * `clarify`) returns `undefined` so the reply text carries the conversation.
 */
export function intentToCards(intent: Intent): AssistantCard[] | undefined {
  switch (intent.intent) {
    case 'create_task':
      return [createTaskIntentToCard(intent)];

    case 'create_reminder': {
      const card = createReminderIntentToCard(intent);
      return card ? [card] : undefined;
    }

    default:
      return undefined;
  }
}

/** Input for {@link buildTaskUpdateCard}. */
export interface BuildTaskUpdateCardParams {
  taskId: string;
  targetTask: string;
  change: string;
  changeType?: TaskUpdateCard['changeType'];
  changes: Record<string, unknown>;
  action: TaskUpdateActionName;
}

/**
 * Phase 11 — builds the confirm-ready `task_update` card for a resolved task.
 * The mutation only runs when the user confirms, which POSTs `action` with
 * `{ taskId, changes }`.
 */
export function buildTaskUpdateCard(params: BuildTaskUpdateCardParams): TaskUpdateCard {
  return {
    type: 'task_update',
    change: params.change,
    targetTask: params.targetTask,
    taskId: params.taskId,
    changes: params.changes,
    action: params.action,
    actions: ['confirm', 'cancel'],
    ...(params.changeType ? { changeType: params.changeType } : {}),
  };
}

/**
 * Phase 11 — builds the disambiguation `task_select` card. Each candidate, when
 * picked, confirms the carried `action` + `changes` for that task.
 */
export function buildTaskSelectCard(
  prompt: string,
  candidates: TaskSelectCandidate[],
  context: { action?: TaskUpdateActionName; changes?: Record<string, unknown> } = {}
): TaskSelectCard {
  return {
    type: 'task_select',
    prompt,
    candidates,
    actions: ['cancel'],
    ...(context.action ? { action: context.action } : {}),
    ...(context.changes ? { changes: context.changes } : {}),
  };
}
