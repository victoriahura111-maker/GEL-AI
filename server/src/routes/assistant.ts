import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { assistantLimiter } from '../middleware/rateLimit';
import { postAssistantMessage } from '../controllers/assistantController';
import { postAssistantAction } from '../controllers/assistantActionsController';

export const assistantRouter = Router();

// The assistant acts on behalf of the authenticated user. `authenticate` runs
// first so the stricter assistant limit is keyed by user id; the limiter then
// protects the external model call from abuse.
assistantRouter.post('/messages', authenticate, assistantLimiter, postAssistantMessage);

// Phase 10 — explicit card actions (create_task / cancel). Creation is
// require-confirmation by default; the assistant never auto-creates.
assistantRouter.post('/actions', authenticate, assistantLimiter, postAssistantAction);
