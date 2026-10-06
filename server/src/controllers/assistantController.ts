import type { Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase';
import {
  assistantMessageSchema,
  MAX_ASSISTANT_HISTORY,
  MAX_CONVERSATION_MESSAGE_LIMIT,
} from '../validators';
import { extractIntent } from '../services/ai/extractor';
import type { ChatTurn } from '../services/ai/extractor';
import {
  buildTaskSelectCard,
  buildTaskUpdateCard,
  createDatabaseChoiceCard,
  intentToCards,
} from '../services/ai/toCards';
import type {
  AssistantCard,
  TaskSelectCandidate,
  TaskUpdateActionName,
  TaskUpdateCard,
} from '../services/ai/toCards';
import { selectDatabase } from '../services/notion/databaseSelection';
import { resolveTask } from '../services/tasks/resolveTask';
import type { TaskRecord } from '../services/tasks/repository';
import type { TaskUpdateChanges } from '../validators/assistantAction';
import type { CreateTaskIntent, Intent } from '../validators/intent';
import { AiServiceError, IntentExtractionError } from '../services/ai/errors';
import { detectFollowUpExpectation, handleFollowUpResponse } from '../services/followup';
import { appendMessage, getOrCreateConversation, listMessages } from '../services/conversations';
import type { ConversationRecord } from '../services/conversations';

/**
 * User-safe fallbacks. They never include stack traces, provider payloads, or
 * raw model output.
 */
const AI_UNAVAILABLE_MESSAGE = "I couldn't process that right now. Please try again.";
const AI_UNPARSEABLE_MESSAGE = "I couldn't understand that request. Please try rephrasing it.";

const FALLBACK_TIMEZONE = 'UTC';

/**
 * Best-effort lookup of the caller's timezone from `user_profiles`. A missing
 * profile, missing column, or Supabase error must never fail the request — we
 * fall back to UTC.
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
 * Reads an optional conversation id from the validated body (preferred) or the
 * `?conversationId=` query string. The value is only ever a *request* — the
 * conversation service verifies ownership before reusing it.
 */
function readConversationId(req: Request, bodyId?: string): string | undefined {
  if (bodyId) return bodyId;

  const query = req.query.conversationId;
  if (typeof query === 'string' && query.trim()) {
    return query.trim();
  }

  return undefined;
}

/**
 * Loads the persisted turns of a conversation for use as model history. Called
 * only when the client omits `messages` this request. Failures degrade to "no
 * history" rather than failing the turn.
 */
async function loadStoredHistory(
  userId: string,
  conversation: ConversationRecord
): Promise<ChatTurn[] | undefined> {
  try {
    const stored = await listMessages(userId, conversation.id, MAX_CONVERSATION_MESSAGE_LIMIT);
    if (stored.length === 0) {
      return undefined;
    }
    // `listMessages` returns the page oldest-first; keep only the most recent
    // turns so the model sees the latest context.
    return stored
      .slice(-MAX_ASSISTANT_HISTORY)
      .map((message) => ({ role: message.role, content: message.content }));
  } catch {
    console.error('[assistant] Could not load stored conversation history.');
    return undefined;
  }
}

/**
 * Phase 10 — enriches a `create_task` preview card with the resolved Notion
 * database, or replaces it with a `confirmation` card listing candidate
 * databases when the choice is ambiguous.
 *
 * Deliberately best-effort: a Supabase hiccup while reading mappings must never
 * break the assistant reply, so failures leave the original card untouched. No
 * task is created here — creation only happens via the explicit confirm action
 * (`POST /api/assistant/actions`), which is require-confirmation by default.
 */
async function enrichCreateTaskCards(
  userId: string,
  intent: CreateTaskIntent,
  cards: AssistantCard[] | undefined
): Promise<AssistantCard[] | undefined> {
  try {
    const selection = await selectDatabase(userId, intent.task.category);

    if (selection.status === 'selected') {
      if (!cards) return cards;
      return cards.map((card) =>
        card.type === 'task'
          ? { ...card, database: { id: selection.databaseId, title: selection.title } }
          : card
      );
    }

    if (selection.status === 'needs_choice') {
      return [createDatabaseChoiceCard(intent, selection.candidates)];
    }

    // No databases mapped: leave the preview card without a database so the
    // user still sees what would be created.
    return cards;
  } catch {
    console.error('[assistant] Could not resolve a Notion database for the task preview.');
    return cards;
  }
}

/** Intents that mutate an existing task and therefore require task resolution. */
const TASK_MUTATION_INTENTS = new Set<Intent['intent']>([
  'update_task',
  'complete_task',
  'cancel_task',
  'delete_task',
  'postpone_task',
  'reschedule_task',
]);

function isTaskMutationIntent(name: Intent['intent']): boolean {
  return TASK_MUTATION_INTENTS.has(name);
}

/** The `task_changes` shape carried by update-family intents (snake_case). */
interface IntentTaskChanges {
  title?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  priority?: 'low' | 'medium' | 'high' | null;
  category?: string | null;
  description?: string | null;
}

/** Maps an intent's snake_case changes to the camelCase service shape. */
function toTaskUpdateChanges(changes: IntentTaskChanges | undefined): TaskUpdateChanges {
  const out: TaskUpdateChanges = {};
  if (!changes) return out;
  if (changes.title !== undefined && changes.title !== null) out.title = changes.title;
  if (changes.description !== undefined) out.description = changes.description;
  if (changes.due_date !== undefined) out.dueDate = changes.due_date;
  if (changes.due_time !== undefined) out.dueTime = changes.due_time;
  if (changes.priority !== undefined) out.priority = changes.priority;
  if (changes.category !== undefined) out.category = changes.category;
  return out;
}

/** Human-readable summary of a proposed change (shown on the confirm card). */
function describeTaskChanges(changes: TaskUpdateChanges): string {
  const parts: string[] = [];
  if (changes.title !== undefined) parts.push(`rename to "${changes.title}"`);
  if (changes.description !== undefined) parts.push('update the description');
  if (changes.dueDate !== undefined || changes.dueTime !== undefined) {
    if (changes.dueDate) {
      parts.push(changes.dueTime ? `move the due date to ${changes.dueDate} ${changes.dueTime}` : `move the due date to ${changes.dueDate}`);
    } else {
      parts.push('change the due date');
    }
  }
  if (changes.priority !== undefined) parts.push(`set priority to ${changes.priority ?? 'none'}`);
  if (changes.status !== undefined) parts.push(`set status to ${changes.status}`);
  if (changes.category !== undefined) parts.push(`set category to ${changes.category ?? 'none'}`);
  if (changes.databaseId !== undefined) parts.push('move it to another database');
  return parts.length > 0 ? `Update: ${parts.join(', ')}` : 'Update this task';
}

/** Converts a mirror row into a selectable candidate. */
function toSelectCandidate(task: TaskRecord): TaskSelectCandidate {
  const dueDate = task.due_date
    ? task.due_time
      ? `${task.due_date} ${task.due_time}`
      : task.due_date
    : undefined;
  return {
    taskId: task.id,
    title: task.title,
    ...(dueDate ? { dueDate } : {}),
    ...(task.category ? { database: task.category } : {}),
  };
}

interface MutationHandling {
  cards: AssistantCard[] | undefined;
  reply: string;
}

/**
 * Phase 11 — resolves the task referenced by an update-family intent and returns
 * either a `task_update` card (found), a `task_select` card (ambiguous), or a
 * conversational clarification (not found). Never mutates anything: mutations
 * only run via the explicit confirm action.
 */
async function handleTaskMutationIntent(userId: string, intent: Intent): Promise<MutationHandling> {
  const defaultReply = intent.reply;

  let action: TaskUpdateActionName = 'update_task';
  let changeType: TaskUpdateCard['changeType'] = 'update';
  let changes: TaskUpdateChanges = {};
  let changeText = 'Update this task';
  let identifier: string | undefined;

  switch (intent.intent) {
    case 'update_task':
      identifier = intent.task_identifier;
      changes = toTaskUpdateChanges(intent.changes);
      action = 'update_task';
      changeType = 'update';
      changeText = describeTaskChanges(changes);
      break;
    case 'complete_task':
      identifier = intent.task_identifier;
      changes = { status: 'completed' };
      action = 'complete_task';
      changeType = 'complete';
      changeText = 'Mark as completed';
      break;
    case 'cancel_task':
      identifier = intent.task_identifier;
      changes = { status: 'cancelled' };
      action = 'cancel_task';
      changeType = 'cancel';
      changeText = 'Cancel the task';
      break;
    case 'delete_task':
      identifier = intent.task_identifier;
      changes = {};
      action = 'delete_task';
      changeType = 'delete';
      changeText = 'Delete the task';
      break;
    case 'postpone_task':
      identifier = intent.task_identifier;
      changes = toTaskUpdateChanges(intent.changes);
      action = 'update_task';
      changeType = 'postpone';
      changeText = describeTaskChanges(changes);
      break;
    case 'reschedule_task':
      identifier = intent.task_identifier;
      changes = toTaskUpdateChanges(intent.changes);
      action = 'update_task';
      changeType = 'reschedule';
      changeText = describeTaskChanges(changes);
      break;
    default:
      return { cards: undefined, reply: defaultReply };
  }

  const resolution = await resolveTask(userId, identifier);

  if (resolution.status === 'not_found') {
    return {
      cards: undefined,
      reply: "I couldn't find a task like that. Could you tell me its name?",
    };
  }

  if (resolution.status === 'ambiguous') {
    const candidates = resolution.candidates.map(toSelectCandidate);
    const prompt = `I found ${candidates.length} tasks that match. Which one do you mean?`;
    const card = buildTaskSelectCard(prompt, candidates, { action, changes });
    return { cards: [card], reply: prompt };
  }

  const card = buildTaskUpdateCard({
    taskId: resolution.task.id,
    targetTask: resolution.task.title,
    change: changeText,
    changeType,
    changes,
    action,
  });
  return { cards: [card], reply: defaultReply };
}

/**
 * Phase 15 — best-effort conversational resolution of a follow-up reply.
 *
 * When the most recent assistant turn asked a follow-up question (a blocking
 * reason or a new deadline), the user's free-text answer is applied directly
 * instead of being re-interpreted by the model. Everything here is guarded: any
 * miss (no expectation, ambiguous title, repository failure) returns `null` so
 * the caller falls through to normal intent extraction. The button/card path
 * does not depend on this.
 */
async function tryFollowUpReply(
  userId: string,
  history: ChatTurn[] | undefined,
  content: string,
  timezone: string
): Promise<{ content: string; cards?: AssistantCard[] } | null> {
  try {
    const expectation = detectFollowUpExpectation(history);
    if (!expectation) return null;

    const resolution = await resolveTask(userId, expectation.taskTitle);
    const taskId =
      resolution.status === 'found'
        ? resolution.task.id
        : resolution.status === 'ambiguous'
          ? resolution.candidates[0]?.id
          : undefined;
    if (!taskId) return null;

    const input =
      expectation.kind === 'reason'
        ? { taskId, response: 'blocked' as const, reason: content }
        : { taskId, response: 'move_deadline' as const, newDeadline: content, timezone };

    const result = await handleFollowUpResponse(userId, input);
    if (result.status === 'not_found') return null;

    return { content: result.message };
  } catch {
    return null;
  }
}

/**
 * `POST /api/assistant/messages`
 *
 * Validates the request, resolves (or starts) the caller's conversation,
 * optionally hydrates prior turns from persistence, calls the AI intent
 * extractor, persists both the user message and the assistant reply (cards as
 * jsonb), and responds with `{ message, conversationId }`.
 *
 * Degradation contract: when Supabase is unconfigured the route still answers
 * 200 with `{ message }` and no `conversationId` (no persistence). Persistence
 * failures are logged and swallowed so a database hiccup never breaks the AI
 * reply.
 */
export async function postAssistantMessage(req: Request, res: Response): Promise<void> {
  const parsed = assistantMessageSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const timezone = await loadUserTimezone(userId);
  const nowIso = new Date().toISOString();

  const requestedConversationId = readConversationId(req, parsed.data.conversationId);

  // Resolve (or create) the caller's conversation. Best-effort: when Supabase is
  // unconfigured or the lookup fails, we continue without persistence.
  let conversation: ConversationRecord | null = null;
  if (supabaseAdmin) {
    try {
      conversation = await getOrCreateConversation(userId, requestedConversationId);
    } catch {
      console.error('[assistant] Could not resolve a conversation; continuing without persistence.');
      conversation = null;
    }
  }
  const conversationId = conversation?.id;

  // Prefer stored turns only when the client did not send its own `messages`.
  // Resolved before persisting the new user message so it is not duplicated.
  let history: ChatTurn[] | undefined = parsed.data.messages;
  if (history === undefined && conversation) {
    history = await loadStoredHistory(userId, conversation);
  }

  // Phase 15 — detect a conversational follow-up reply from the resolved
  // history: the client-provided turns, or the stored turns the server loaded
  // when the client omitted `messages` (that path includes proactive follow-up
  // messages). No extra DB read is performed so the existing history contract
  // is preserved.
  const followUpReply = await tryFollowUpReply(userId, history, parsed.data.content, timezone);

  if (followUpReply) {
    if (conversation) {
      try {
        await appendMessage(userId, conversation.id, { role: 'user', content: parsed.data.content });
      } catch {
        console.error('[assistant] Could not persist the follow-up reply (user turn).');
      }
      try {
        await appendMessage(userId, conversation.id, {
          role: 'assistant',
          content: followUpReply.content,
          cards: followUpReply.cards ?? null,
        });
      } catch {
        console.error('[assistant] Could not persist the follow-up reply (assistant turn).');
      }
    }

    res.status(200).json({
      message: {
        role: 'assistant',
        content: followUpReply.content,
        ...(followUpReply.cards ? { cards: followUpReply.cards } : {}),
      },
      ...(conversationId ? { conversationId } : {}),
    });
    return;
  }

  // Persist the inbound user message before the AI call (best-effort).
  if (conversation) {
    try {
      await appendMessage(userId, conversation.id, {
        role: 'user',
        content: parsed.data.content,
      });
    } catch {
      console.error('[assistant] Could not persist the user message.');
    }
  }

  try {
    const intent = await extractIntent({
      content: parsed.data.content,
      history,
      timezone,
      nowIso,
    });

    let cards = intentToCards(intent);
    let replyContent = intent.reply;

    // Phase 17 — defence in depth: a model response NEVER performs a privileged
    // mutation on its own. This branch only builds preview/select/update cards;
    // every write happens later through an explicit user confirm action
    // (`POST /api/assistant/actions`) and is scoped to the authenticated user.
    // Phase 10: attach the resolved Notion database (or ask which database).
    if (intent.intent === 'create_task') {
      cards = await enrichCreateTaskCards(userId, intent, cards);
    } else if (isTaskMutationIntent(intent.intent)) {
      // Phase 11: resolve the target task and propose the change (or disambiguate).
      const handled = await handleTaskMutationIntent(userId, intent);
      cards = handled.cards;
      replyContent = handled.reply;
    }

    // Persist the assistant reply (cards serialized as jsonb) best-effort.
    if (conversation) {
      try {
        await appendMessage(userId, conversation.id, {
          role: 'assistant',
          content: replyContent,
          cards: cards ?? null,
        });
      } catch {
        console.error('[assistant] Could not persist the assistant reply.');
      }
    }

    res.status(200).json({
      message: {
        role: 'assistant',
        content: replyContent,
        ...(cards ? { cards } : {}),
      },
      ...(conversationId ? { conversationId } : {}),
    });
  } catch (error) {
    if (error instanceof AiServiceError) {
      if (error.code === 'not_configured') {
        res.status(503).json({ error: 'The AI assistant is not configured on this server.' });
        return;
      }

      console.error(`[assistant] AI provider failure (${error.code}).`);
      res.status(502).json({ error: AI_UNAVAILABLE_MESSAGE });
      return;
    }

    if (error instanceof IntentExtractionError) {
      console.error('[assistant] Could not parse the AI intent output.');
      res.status(502).json({ error: AI_UNPARSEABLE_MESSAGE });
      return;
    }

    console.error('[assistant] Unexpected error while processing a message.');
    res.status(502).json({ error: AI_UNAVAILABLE_MESSAGE });
  }
}
