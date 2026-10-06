import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import type { AppendMessageInput } from '../../validators/conversation';

/**
 * Server-side repository for assistant conversations and messages.
 *
 * Every query is scoped to the authenticated `userId`; a conversation id that
 * is not owned by the caller is treated as if it did not exist, so a foreign id
 * can never be read, appended to, or enumerated.
 *
 * When Supabase is unconfigured the functions degrade gracefully (`null`/`[]`)
 * instead of throwing so the assistant route can skip persistence.
 */

export type ConversationRole = 'user' | 'assistant';

/** Row shape of `public.assistant_conversations`. */
export interface ConversationRecord {
  id: string;
  user_id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape of `public.assistant_messages`. */
export interface MessageRecord {
  id: string;
  conversation_id: string;
  user_id: string;
  role: ConversationRole;
  content: string;
  cards: unknown[] | null;
  created_at: string;
}

/** Raised when a database operation fails (distinct from "not configured"). */
export class ConversationRepositoryError extends Error {
  constructor(operation: string, message: string) {
    super(`[conversations] ${operation} failed: ${message}`);
    this.name = 'ConversationRepositoryError';
  }
}

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;
const DEFAULT_CONVERSATION_LIMIT = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Client-supplied ids are only meaningful if they are real UUIDs. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Fetches an owned conversation, or `null` when absent / not owned / not a UUID. */
export async function getConversation(
  userId: string,
  conversationId: string
): Promise<ConversationRecord | null> {
  const admin = client();
  if (!admin) return null;
  if (!isUuid(conversationId)) return null;

  const { data, error } = await admin
    .from('assistant_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new ConversationRepositoryError('getConversation', error.message);
  }

  return (data as ConversationRecord | null) ?? null;
}

/**
 * Resolves the conversation to use for `userId`.
 *
 * - When `conversationId` is a UUID owned by the caller it is reused.
 * - Otherwise (absent, malformed, or owned by another user) a new conversation
 *   is created for the caller.
 */
export async function getOrCreateConversation(
  userId: string,
  conversationId?: string
): Promise<ConversationRecord | null> {
  const admin = client();
  if (!admin) return null;

  if (conversationId) {
    const existing = await getConversation(userId, conversationId);
    if (existing) return existing;
  }

  const { data, error } = await admin
    .from('assistant_conversations')
    .insert({ user_id: userId })
    .select('*')
    .single();

  if (error) {
    throw new ConversationRepositoryError('getOrCreateConversation', error.message);
  }

  return (data as ConversationRecord | null) ?? null;
}

/**
 * Appends a message to an owned conversation and bumps the conversation's
 * `last_message_at`. Message ownership is recorded explicitly so every row can
 * be scoped by `user_id`.
 */
export async function appendMessage(
  userId: string,
  conversationId: string,
  input: AppendMessageInput
): Promise<MessageRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from('assistant_messages')
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      role: input.role,
      content: input.content,
      cards: input.cards ?? null,
    })
    .select('*')
    .single();

  if (error) {
    throw new ConversationRepositoryError('appendMessage', error.message);
  }

  // Best-effort activity timestamp. A failure here must not lose the message
  // that was already persisted, so it is swallowed deliberately.
  try {
    await admin
      .from('assistant_conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', userId);
  } catch {
    // Intentionally ignored.
  }

  return (data as MessageRecord | null) ?? null;
}

/**
 * Lists a conversation's messages in chronological order. Returns `[]` for a
 * conversation that is not owned by `userId` (the query is scoped by user_id).
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  limit?: number
): Promise<MessageRecord[]> {
  const admin = client();
  if (!admin) return [];

  const capped = Math.min(Math.max(limit ?? DEFAULT_MESSAGE_LIMIT, 1), MAX_MESSAGE_LIMIT);

  const { data, error } = await admin
    .from('assistant_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(capped);

  if (error) {
    throw new ConversationRepositoryError('listMessages', error.message);
  }

  return (data as MessageRecord[] | null) ?? [];
}

/** Lists the caller's conversations, most recently active first. */
export async function listConversations(userId: string): Promise<ConversationRecord[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin
    .from('assistant_conversations')
    .select('*')
    .eq('user_id', userId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(DEFAULT_CONVERSATION_LIMIT);

  if (error) {
    throw new ConversationRepositoryError('listConversations', error.message);
  }

  return (data as ConversationRecord[] | null) ?? [];
}
