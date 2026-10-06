import { z } from 'zod';

/** Server-side cap on how many prior turns are accepted from the client. */
export const MAX_ASSISTANT_HISTORY = 20;
/** Per-message character cap, applied to the prompt and to each history turn. */
export const MAX_ASSISTANT_CONTENT_LENGTH = 4000;

const historyMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(MAX_ASSISTANT_CONTENT_LENGTH),
  })
  .strict();

/**
 * Request body for `POST /api/assistant/messages`.
 *
 * `messages` is optional prior conversation history; it is length- and
 * size-capped server-side so a client cannot flood the model context.
 *
 * `conversationId` is optional: the server returns the conversation it used in
 * the response, and the client echoes it back on subsequent turns. A missing,
 * malformed, or foreign id causes the server to start a new conversation for
 * the authenticated user — a client can never select someone else's thread.
 */
export const assistantMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_ASSISTANT_CONTENT_LENGTH),
    messages: z.array(historyMessageSchema).max(MAX_ASSISTANT_HISTORY).optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

export type AssistantMessageInput = z.infer<typeof assistantMessageSchema>;
