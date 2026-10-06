import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import {
  getNotifications,
  getUnreadCount,
  postMarkAllRead,
  postMarkRead,
} from '../controllers/notificationsController';

export const notificationsRouter = Router();

// Phase 14 — notification center. Every route is caller-scoped and
// token-protected; handler logic lives in the controller.
notificationsRouter.use(authenticate);

notificationsRouter.get('/', getNotifications);
notificationsRouter.get('/unread-count', getUnreadCount);
// Register the literal `read-all` before the `/:id/read` pattern for clarity.
notificationsRouter.post('/read-all', postMarkAllRead);
notificationsRouter.post('/:id/read', postMarkRead);
