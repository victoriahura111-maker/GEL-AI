import { z } from 'zod';

/** Conversational roles accepted when persisting a message. */
export const CONVERSATION_ROLES = ['user', 'assistant'] as const;

/** Per-message character cap for persisted conversation content. */
export const MAX_CONVERSATION_CONTENT_LENGTH = 8000;
/** Server-side cap on a single message page. */
export const MAX_CONVERSATION_MESSAGE_LIMIT = 100;
/** Default page size when the caller does not supply `limit`. */
export const DEFAULT_CONVERSATION_MESSAGE_LIMIT = 50;

/**
 * Payload for appending a message to a conversation. `user_id` and
 * `conversation_id` are never taken from here — they come from the
 * authenticated request and the resolved conversation.
 */
export const appendMessageInputSchema = z
  .object({
    role: z.enum(CONVERSATION_ROLES),
    content: z.string().trim().min(1).max(MAX_CONVERSATION_CONTENT_LENGTH),
    // Opaque structured UI cards persisted as jsonb; validated as JSON values.
    cards: z.array(z.unknown()).nullable().optional(),
  })
  .strict();

/** A conversation id must be a UUID (server-assigned). */
export const conversationIdParamSchema = z.string().uuid();

/** Validated query string for the message-list endpoint. */
export const conversationMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_CONVERSATION_MESSAGE_LIMIT).optional(),
});

export type AppendMessageInput = z.infer<typeof appendMessageInputSchema>;
export type ConversationMessagesQuery = z.infer<typeof conversationMessagesQuerySchema>;
