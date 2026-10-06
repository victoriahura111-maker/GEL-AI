export type Role = 'user' | 'assistant';

export type MessageStatus = 'sending' | 'sent' | 'error';

export type CardType =
  | 'task'
  | 'reminder'
  | 'task_update'
  | 'task_select'
  | 'confirmation'
  | 'follow_up';

export type TaskPriority = 'low' | 'medium' | 'high';

export type TaskAction = 'create' | 'edit' | 'cancel';
export type ReminderAction = 'set' | 'cancel';
export type TaskUpdateAction = 'confirm' | 'cancel';
export type ConfirmationAction = 'confirm' | 'cancel';

/** Which action endpoint a `task_update` / `task_select` confirm maps to. */
export type TaskUpdateActionName =
  | 'update_task'
  | 'complete_task'
  | 'cancel_task'
  | 'delete_task'
  | 'move_task';

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

/**
 * Structured task fields carried by a preview card so it can be confirmed
 * without re-parsing free text. Mirrors the server's `TaskCardPayload`.
 */
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

export interface TaskCard {
  type: 'task';
  /** Human-readable task preview title. */
  title: string;
  /** Human-readable due line, e.g. "Today, 5:00 PM". */
  due?: string;
  /** ISO 8601 due date-time for machine use. */
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
  /** Human-readable scheduled time, e.g. "Today, 9:00 AM". */
  time: string;
  /** Additional context, e.g. "30 minutes before deadline". */
  description?: string;
  actions: ReminderAction[];
}

export interface TaskUpdateCard {
  type: 'task_update';
  /** The proposed change, e.g. "Mark as complete" or "Reschedule to tomorrow". */
  change: string;
  /** Optional machine-readable change kind. */
  changeType?: 'complete' | 'cancel' | 'delete' | 'reschedule' | 'postpone' | 'update' | 'move';
  /** The target task the change applies to. */
  targetTask: string;
  /** The mirror task id the change applies to. */
  taskId?: string;
  /** The structured change payload posted on confirm. */
  changes?: Record<string, unknown>;
  /** The action endpoint to POST on confirm. */
  action?: TaskUpdateActionName;
  actions: TaskUpdateAction[];
}

/** One selectable task candidate for the disambiguation flow. */
export interface TaskSelectCandidate {
  taskId: string;
  title: string;
  dueDate?: string;
  database?: string;
}

export interface TaskSelectCard {
  type: 'task_select';
  /** The disambiguation prompt, e.g. "I found three reports. Which one?". */
  prompt: string;
  candidates: TaskSelectCandidate[];
  /** The action to POST when a candidate is picked. */
  action?: TaskUpdateActionName;
  changes?: Record<string, unknown>;
  actions: TaskUpdateAction[];
}

export interface ConfirmationCard {
  type: 'confirmation';
  /** The yes/no prompt, e.g. "Create in Work Tasks?". */
  prompt: string;
  actions: ConfirmationAction[];
  /** Candidate databases the user can pick from. */
  candidates?: DatabaseCandidate[];
  /** The task payload carried through the choice so the pick can confirm it. */
  task?: TaskCardPayload;
  reminder?: CardReminderPayload;
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
 * Phase 15 — an interactive follow-up prompt rendered in the chat. `kind`
 * selects the button set: a `due_soon` card offers progress updates, an
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
  | TaskUpdateCard
  | TaskSelectCard
  | ConfirmationCard
  | FollowUpCard;

export interface AssistantMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  cards?: AssistantCard[];
}

/** `POST /api/assistant/actions` request bodies. */
export interface CreateTaskActionRequest {
  action: 'create_task';
  task: TaskCardPayload;
  reminder?: CardReminderPayload;
  databaseId?: string;
  conversationId?: string;
}

export interface CancelActionRequest {
  action: 'cancel';
  conversationId?: string;
}

export interface UpdateTaskActionRequest {
  action: 'update_task';
  taskId: string;
  changes: Record<string, unknown>;
  conversationId?: string;
}

export interface CompleteTaskActionRequest {
  action: 'complete_task';
  taskId: string;
  conversationId?: string;
}

export interface CancelTaskActionRequest {
  action: 'cancel_task';
  taskId: string;
  conversationId?: string;
}

export interface DeleteTaskActionRequest {
  action: 'delete_task';
  taskId: string;
  conversationId?: string;
}

export interface MoveTaskActionRequest {
  action: 'move_task';
  taskId: string;
  databaseId: string;
  conversationId?: string;
}

export interface UpdateReminderActionRequest {
  action: 'update_reminder';
  reminderId: string;
  scheduledFor?: string;
  timezone?: string | null;
  conversationId?: string;
}

export interface CancelReminderActionRequest {
  action: 'cancel_reminder';
  reminderId: string;
  conversationId?: string;
}

/** Phase 15 — a direct button answer on a follow-up card. */
export interface FollowUpResponseActionRequest {
  action: 'follow_up_response';
  taskId: string;
  response: FollowUpActionId;
  reason?: string;
  conversationId?: string;
}

/** Phase 15 — stores a blocking reason for a task. */
export interface FollowUpReasonActionRequest {
  action: 'follow_up_reason';
  taskId: string;
  reason: string;
  conversationId?: string;
}

/** Phase 15 — moves a task's deadline from a follow-up card. */
export interface FollowUpNewDeadlineActionRequest {
  action: 'follow_up_new_deadline';
  taskId: string;
  deadline?: string;
  date?: string;
  datetime?: string;
  timezone?: string | null;
  conversationId?: string;
}

export type AssistantActionRequest =
  | CreateTaskActionRequest
  | CancelActionRequest
  | UpdateTaskActionRequest
  | CompleteTaskActionRequest
  | CancelTaskActionRequest
  | DeleteTaskActionRequest
  | MoveTaskActionRequest
  | UpdateReminderActionRequest
  | CancelReminderActionRequest
  | FollowUpResponseActionRequest
  | FollowUpReasonActionRequest
  | FollowUpNewDeadlineActionRequest;

/**
 * Typed error thrown by the assistant service. The message is always safe to
 * show directly to the user.
 */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}
