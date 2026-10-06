import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';

export const healthRouter = Router();

/**
 * Liveness probe (Phase 19).
 *
 * Deliberately cheap: it performs no I/O and reads no configuration, so it
 * stays green as long as the process is serving HTTP. Suitable for a
 * container/orchestrator liveness check (`GET /health`).
 */
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Readiness probe (Phase 19).
 *
 * Reports whether the **core** dependency (Supabase — the datastore and auth
 * provider) is configured, plus the configuration state of the optional
 * integrations and the background scheduler flags. It exposes **booleans and
 * metadata only** — never a URL, key, token, or any other secret — so it is safe
 * to expose to an orchestrator or a public probe (`GET /health/ready`).
 *
 * The status code is `200` when Supabase is configured and `503` otherwise, so a
 * load balancer does not route authenticated traffic to an instance that cannot
 * serve it. Missing optional integrations (AI, Notion) do **not** change the
 * status code: the server is designed to degrade gracefully and their specific
 * endpoints return their own `503`s when unconfigured.
 */
healthRouter.get('/ready', (_req: Request, res: Response) => {
  const checks = {
    supabase: config.isSupabaseConfigured,
    ai: config.isAiConfigured,
    notion: config.isNotionConfigured,
    encryption: config.isEncryptionConfigured,
  };

  const ready = checks.supabase;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    checks,
    schedulersEnabled: {
      reminders: config.remindersEnabled,
      followUps: config.followUpEnabled,
      sync: config.syncEnabled,
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});
