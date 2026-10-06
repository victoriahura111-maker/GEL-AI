import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import {
  getConversationMessages,
  getConversations,
} from '../controllers/conversationsController';

export const conversationsRouter = Router();

// Every conversation route is caller-scoped and requires a verified token.
conversationsRouter.use(authenticate);

conversationsRouter.get('/', getConversations);
conversationsRouter.get('/:id/messages', getConversationMessages);
