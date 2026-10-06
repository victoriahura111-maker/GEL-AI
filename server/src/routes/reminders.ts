import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import {
  getReminders,
  postCancelReminder,
  postCreateReminder,
  postRescheduleReminder,
} from '../controllers/remindersController';

export const remindersRouter = Router();

// Phase 13 — reminder management. Every route is caller-scoped and
// token-protected; handler logic lives in the controller.
remindersRouter.use(authenticate);

remindersRouter.get('/', getReminders);
remindersRouter.post('/', postCreateReminder);
remindersRouter.post('/:id/cancel', postCancelReminder);
remindersRouter.post('/:id/reschedule', postRescheduleReminder);
