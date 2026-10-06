import express from 'express';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { notFoundHandler } from './middleware/notFoundHandler';
import { requestLogger } from './middleware/requestLogger';
import { globalLimiter } from './middleware/rateLimit';
import { corsMiddleware, securityHeaders } from './middleware/security';
import {
  assistantRouter,
  authRouter,
  conversationsRouter,
  healthRouter,
  notificationsRouter,
  notionRouter,
  remindersRouter,
  syncRouter,
  tasksRouter,
} from './routes';

export function createApp() {
  const app = express();

  // Phase 17 — transport hardening. `x-powered-by` is removed; `trust proxy` is
  // configured from TRUST_PROXY so per-IP limits see the real client behind a
  // trusted proxy and are not fooled by spoofed X-Forwarded-* headers.
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(corsMiddleware);

  // Bodies are capped at 100kb (assistant content is already capped at 4000
  // characters). Oversized payloads are rejected with 413 by the error handler.
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.jsonBodyLimit }));
  app.use(requestLogger);

  // Every `/api/*` route shares a global limit; the per-route limiters in the
  // routers below are stricter for expensive endpoints.
  app.use('/api', globalLimiter);

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/assistant', assistantRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/notion', notionRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/reminders', remindersRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/sync', syncRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
