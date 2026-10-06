import type { Request, Response } from 'express';
import { getConversation, listConversations, listMessages } from '../services/conversations';
import { conversationIdParamSchema, conversationMessagesQuerySchema } from '../validators';

/**
 * `GET /api/conversations`
 *
 * Lists the authenticated caller's conversations, most recently active first.
 * The user id always comes from the verified token, never the request.
 */
export async function getConversations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const conversations = await listConversations(userId);
    res.json({ conversations });
  } catch {
    console.error('[conversations] Could not list conversations.');
    res.status(500).json({ error: 'Could not load conversations' });
  }
}

/**
 * `GET /api/conversations/:id/messages`
 *
 * Lists the messages of a conversation owned by the caller. A conversation that
 * does not exist or belongs to another user resolves to 404 — a foreign id is
 * never distinguishable from a missing one, and its contents are never exposed.
 */
export async function getConversationMessages(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const idParsed = conversationIdParamSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    res.status(400).json({ error: 'Invalid conversation id' });
    return;
  }

  const queryParsed = conversationMessagesQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({
      error: 'Invalid query parameters',
      details: queryParsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const owned = await getConversation(userId, idParsed.data);
    if (!owned) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const messages = await listMessages(userId, idParsed.data, queryParsed.data.limit);
    res.json({ messages });
  } catch {
    console.error('[conversations] Could not load conversation messages.');
    res.status(500).json({ error: 'Could not load messages' });
  }
}
