import { apiRequest } from './api';
import { ChatError } from '../types/assistant';
import type {
  AssistantActionRequest,
  AssistantCard,
  AssistantMessage,
  DatabaseCandidate,
  DatabaseRef,
  Role,
} from '../types/assistant';

const DEFAULT_ERROR_MESSAGE = 'I could not reach the assistant. Please try again.';

/**
 * Small client-side id generator for optimistic messages. Not meant to be a
 * collision-proof unique id — the server owns the real conversation identity.
 */
export function makeId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Builds an optimistic user message ready to be appended to the UI. */
export function createUserMessage(content: string): AssistantMessage {
  return {
    id: makeId(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    status: 'sent',
  };
}

/** A single prior turn sent to the backend as conversational context. */
interface AssistantHistoryTurn {
  role: Role;
  content: string;
}

/** Keep the outbound history within the backend's accepted cap. */
const MAX_HISTORY_TURNS = 20;

/** The `POST /api/assistant/messages` response contract (Phase 6). */
interface AssistantResponse {
  message: {
    role: Role;
    content: string;
    cards?: AssistantCard[];
  };
  conversationId?: string;
}

/** Result of a successful send: the reply plus the server-owned conversation id. */
export interface AssistantSendResult {
  message: AssistantMessage;
  conversationId: string | null;
}

/** Maps the most recent prior UI messages to the `{ role, content }` API turns. */
function toHistoryTurns(history: AssistantMessage[]): AssistantHistoryTurn[] {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Sends the user's message (plus recent conversation history) to the assistant
 * endpoint and returns the assistant reply together with the server-issued
 * `conversationId` to reuse on the next turn.
 *
 * The backend responds with `{ message: { role, content, cards? }, conversationId }`.
 * When the server is not persisting conversations the `conversationId` is
 * `null`; the caller keeps whatever it had. Any failure is surfaced as a
 * `ChatError` whose message is safe to show the user.
 */
export async function sendAssistantMessage(
  conversationId: string | null,
  content: string,
  history: AssistantMessage[] = []
): Promise<AssistantSendResult> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';

  try {
    const response = await apiRequest<AssistantResponse>(`/api/assistant/messages${query}`, {
      method: 'POST',
      body: JSON.stringify({ content, messages: toHistoryTurns(history) }),
    });

    const reply = response?.message;

    if (!reply || typeof reply.content !== 'string') {
      throw new ChatError(DEFAULT_ERROR_MESSAGE);
    }

    const assistantMessage: AssistantMessage = {
      id: makeId(),
      role: 'assistant',
      content: reply.content,
      createdAt: new Date().toISOString(),
    };

    if (reply.cards && reply.cards.length > 0) {
      assistantMessage.cards = reply.cards;
    }

    return {
      message: assistantMessage,
      conversationId: response.conversationId ?? null,
    };
  } catch (error) {
    if (error instanceof ChatError) {
      throw error;
    }
    throw new ChatError(DEFAULT_ERROR_MESSAGE);
  }
}

/** The `POST /api/assistant/actions` response contract (Phase 10/11). */
interface AssistantActionResponse {
  message: {
    role: Role;
    content: string;
    cards?: AssistantCard[];
  };
  conversationId?: string;
  task?: unknown;
  notionUrl?: string | null;
  database?: DatabaseRef;
  needsDatabase?: boolean;
  candidates?: DatabaseCandidate[];
  /** Non-fatal notes about a partially-applied change. */
  warnings?: string[];
}

/** Result of a card action: the assistant reply + flow metadata. */
export interface AssistantActionResult {
  message: AssistantMessage;
  conversationId: string | null;
  /** True when the assistant needs the user to choose a database. */
  needsDatabase: boolean;
  candidates: DatabaseCandidate[];
  notionUrl: string | null;
  /** Non-fatal notes about a partially-applied change. */
  warnings: string[];
}

/**
 * Performs an explicit card action (`create_task` / `cancel`).
 *
 * Returns the assistant's follow-up message (which may carry a created-task card
 * with a `notionUrl`, or a "which database?" confirmation card), plus flags the
 * caller uses to render the result. Failures surface as a `ChatError` whose
 * message is safe to display.
 */
export async function postAssistantAction(
  payload: AssistantActionRequest
): Promise<AssistantActionResult> {
  try {
    const response = await apiRequest<AssistantActionResponse>('/api/assistant/actions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const reply = response?.message;
    if (!reply || typeof reply.content !== 'string') {
      throw new ChatError(DEFAULT_ERROR_MESSAGE);
    }

    const assistantMessage: AssistantMessage = {
      id: makeId(),
      role: 'assistant',
      content: reply.content,
      createdAt: new Date().toISOString(),
    };
    if (reply.cards && reply.cards.length > 0) {
      assistantMessage.cards = reply.cards;
    }

    return {
      message: assistantMessage,
      conversationId: response.conversationId ?? null,
      needsDatabase: response.needsDatabase === true,
      candidates: response.candidates ?? [],
      notionUrl: response.notionUrl ?? null,
      warnings: response.warnings ?? [],
    };
  } catch (error) {
    if (error instanceof ChatError) {
      throw error;
    }
    throw new ChatError(DEFAULT_ERROR_MESSAGE);
  }
}
