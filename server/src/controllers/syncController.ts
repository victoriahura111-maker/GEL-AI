import type { Request, Response } from 'express';
import {
  checkSyncCooldown,
  getSyncStatus,
  isNotionConnected,
  isSyncConfigured,
  recordSyncAttempt,
  syncUser,
} from '../services/sync';
import { syncRequestSchema } from '../validators/sync';

/**
 * Phase 16 — synchronization controllers.
 *
 * Thin handlers over `services/sync`. All work is scoped to `req.user.id`; no
 * Notion token or raw payload is ever read or returned. Error mapping:
 *  - `401` no authenticated user,
 *  - `400` invalid `direction`,
 *  - `409` Notion not connected,
 *  - `429` a sync ran within the per-user cooldown,
 *  - `503` synchronization is not configured.
 */

/** `POST /api/sync` — runs a manual sync and returns the typed summary. */
export async function postSync(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!isSyncConfigured()) {
    res.status(503).json({ error: 'Synchronization is not configured' });
    return;
  }

  const parsed = syncRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid sync direction' });
    return;
  }

  if (!(await isNotionConnected(userId))) {
    res.status(409).json({ error: 'Connect Notion first' });
    return;
  }

  const decision = checkSyncCooldown(userId);
  if (!decision.allowed) {
    res.status(429).json({
      error: 'A sync ran recently. Please wait a moment before trying again.',
      retryAfterMs: decision.retryAfterMs,
    });
    return;
  }

  recordSyncAttempt(userId);

  try {
    const summary = await syncUser(userId, { direction: parsed.data.direction ?? 'both' });
    res.json(summary);
  } catch {
    // `syncUser` never throws, but keep the endpoint safe regardless.
    console.error('[sync] Manual sync failed unexpectedly.');
    res.status(500).json({ error: 'Could not complete the sync' });
  }
}

/** `GET /api/sync/status` — last sync time, per-status counts, recent errors. */
export async function getSyncStatusHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!isSyncConfigured()) {
    res.status(503).json({ error: 'Synchronization is not configured' });
    return;
  }

  try {
    const status = await getSyncStatus(userId);
    res.json(status);
  } catch {
    console.error('[sync] Could not build the sync status.');
    res.status(500).json({ error: 'Could not load the sync status' });
  }
}
