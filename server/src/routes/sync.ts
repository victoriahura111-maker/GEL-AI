import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { syncLimiter } from '../middleware/rateLimit';
import { getSyncStatusHandler, postSync } from '../controllers/syncController';

export const syncRouter = Router();

// Phase 16 — Notion ⇄ local synchronization. Every route is caller-scoped and
// token-protected; handler logic lives in the controller.
syncRouter.use(authenticate);

// The stricter sync limit is keyed by user id (authenticate runs above) and is
// complemented by the per-user cooldown inside the controller.
syncRouter.post('/', syncLimiter, postSync);
syncRouter.get('/status', getSyncStatusHandler);
