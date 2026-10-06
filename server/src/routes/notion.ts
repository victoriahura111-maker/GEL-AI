import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { notionLimiter } from '../middleware/rateLimit';
import {
  disconnectNotion,
  getNotionConnectionStatus,
  notionOAuthCallback,
  startNotionOAuth,
} from '../controllers/notionController';
import {
  deleteNotionDatabaseMapping,
  getNotionDatabaseSchema,
  getNotionDatabases,
  putNotionDatabaseMapping,
} from '../controllers/notionDatabasesController';

export const notionRouter = Router();

// Phase 7 — Notion OAuth / connection. Handler logic lives in the controller.

// Starts the flow for the authenticated user (returns the public auth URL).
notionRouter.get('/oauth/start', authenticate, notionLimiter, startNotionOAuth);

// Browser redirect target: NOT authenticated by Bearer token. Trust is derived
// from the signed, single-use OAuth state verified inside the controller. The
// limiter is keyed by IP here (there is no Bearer token to key on).
notionRouter.get('/oauth/callback', notionLimiter, notionOAuthCallback);

// Connection status / disconnect: caller-scoped and token-protected.
notionRouter.get('/connection', authenticate, notionLimiter, getNotionConnectionStatus);
notionRouter.delete('/connection', authenticate, notionLimiter, disconnectNotion);

// Phase 8 — Notion database discovery + purpose configuration.
// Lists the databases shared with the integration, annotated with the caller's
// saved purpose/default (409 when Notion is not connected / must reconnect).
notionRouter.get('/databases', authenticate, notionLimiter, getNotionDatabases);

// Phase 9 — schema inspection: flattened properties + resolved field mapping.
// Declared before the `:databaseId/mapping` routes but the paths do not collide.
notionRouter.get(
  '/databases/:databaseId/schema',
  authenticate,
  notionLimiter,
  getNotionDatabaseSchema
);

// Upserts / removes the caller's purpose (+ default) mapping for one database.
notionRouter.put(
  '/databases/:databaseId/mapping',
  authenticate,
  notionLimiter,
  putNotionDatabaseMapping
);
notionRouter.delete(
  '/databases/:databaseId/mapping',
  authenticate,
  notionLimiter,
  deleteNotionDatabaseMapping
);
