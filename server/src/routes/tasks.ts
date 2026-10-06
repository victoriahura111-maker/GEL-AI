import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { getTask, getTaskSummary, getTasks, getTasksGrouped } from '../controllers/tasksController';

export const tasksRouter = Router();

// Phase 12 — task dashboard. Every route is caller-scoped and token-protected;
// handler logic lives in the controller.
tasksRouter.use(authenticate);

// The collection + the two literal sub-resources are declared before `/:id` so
// they are matched first (a task id can otherwise shadow them).
tasksRouter.get('/', getTasks);
tasksRouter.get('/summary', getTaskSummary);
tasksRouter.get('/grouped', getTasksGrouped);
tasksRouter.get('/:id', getTask);
