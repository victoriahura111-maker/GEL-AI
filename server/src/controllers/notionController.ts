import type { Request, Response } from 'express';
import { config } from '../config';
import { writeAuditLog } from '../services/audit';
import {
  buildAuthorizationUrl,
  createState,
  exchangeCodeForToken,
  NotionOAuthError,
  OAuthStateError,
  verifyState,
} from '../services/notion';
import {
  deleteConnection,
  getConnectionSummary,
  upsertConnection,
} from '../services/notion/connectionRepository';

/**
 * Phase 7 — Notion OAuth + connection status controllers.
 *
 * Security invariants:
 * - The OAuth `state` is signed, expiring, single-use, and bound to the
 *   authenticated user; the callback derives the user id ONLY from the verified
 *   state payload (never from a query parameter).
 * - The client secret and the Notion access token never reach the browser, are
 *   never logged, and never appear in a redirect URL. Callback failures carry a
 *   short, fixed `reason` code instead.
 */

const NOTION_SETTINGS_PATH = '/settings/notion';

/**
 * Maps an internal failure to a short, non-sensitive `reason` code for the
 * redirect back to the app. Provider messages, tokens, and secrets are never
 * part of this value.
 */
function safeErrorReason(error: unknown): string {
  if (error instanceof OAuthStateError) {
    switch (error.code) {
      case 'expired':
        return 'state_expired';
      case 'replayed':
        return 'state_replayed';
      case 'invalid_signature':
        return 'state_invalid';
      case 'not_configured':
        return 'not_configured';
      default:
        return 'state_malformed';
    }
  }

  if (error instanceof NotionOAuthError) {
    switch (error.code) {
      case 'not_configured':
        return 'not_configured';
      case 'network_error':
        return 'network_error';
      default:
        return 'exchange_failed';
    }
  }

  return 'unknown';
}

/** Builds the redirect target under APP_URL and clears any stale query flags. */
function buildRedirectUrl(query: Record<string, string>): string {
  const url = new URL(NOTION_SETTINGS_PATH, config.appUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * `GET /api/notion/oauth/start`
 *
 * Mints a signed state for the caller and returns the public Notion
 * authorization URL. 503 when Notion is not configured server-side.
 */
export async function startNotionOAuth(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!config.isNotionConfigured) {
    res.status(503).json({ error: 'Notion integration is not configured' });
    return;
  }

  try {
    const state = createState(userId);
    const authorizationUrl = buildAuthorizationUrl(state);
    res.json({ authorizationUrl });
  } catch (error) {
    if (error instanceof NotionOAuthError && error.code === 'not_configured') {
      res.status(503).json({ error: 'Notion integration is not configured' });
      return;
    }
    if (error instanceof OAuthStateError && error.code === 'not_configured') {
      res.status(503).json({ error: 'Notion integration is not configured' });
      return;
    }
    console.error('[notion] Failed to start the OAuth flow.');
    res.status(500).json({ error: 'Could not start the Notion connection' });
  }
}

/**
 * `GET /api/notion/oauth/callback`
 *
 * Browser redirect target — intentionally unauthenticated (no Bearer token).
 * Validates the signed state, exchanges the code server-side, encrypts and
 * stores the token, then 302-redirects to the app. Every failure redirects to
 * the app with a safe `reason` code.
 */
export async function notionOAuthCallback(req: Request, res: Response): Promise<void> {
  const { error: providerError, code, state } = req.query as Record<string, unknown>;

  // 1. Notion returned an explicit error (e.g. the user denied access).
  if (typeof providerError === 'string' && providerError.length > 0) {
    console.warn('[notion] Authorization was denied or failed at the provider.');
    res.redirect(302, buildRedirectUrl({ notion: 'error', reason: 'access_denied' }));
    return;
  }

  // 2. Validate the state: signature, expiry, single-use. Yields the user id.
  let userId: string;
  try {
    const payload = verifyState(state);
    userId = payload.userId;
  } catch (error) {
    const reason = safeErrorReason(error);
    console.warn(`[notion] OAuth callback rejected the state (reason=${reason}).`);
    res.redirect(302, buildRedirectUrl({ notion: 'error', reason }));
    return;
  }

  // 3. Require the authorization code.
  if (typeof code !== 'string' || code.length === 0) {
    console.warn('[notion] OAuth callback did not include an authorization code.');
    res.redirect(302, buildRedirectUrl({ notion: 'error', reason: 'missing_code' }));
    return;
  }

  // 4. Exchange the code and persist the encrypted token.
  try {
    const token = await exchangeCodeForToken(code);

    await upsertConnection(userId, {
      accessToken: token.access_token,
      botId: token.bot_id,
      workspaceId: token.workspace_id,
      workspaceName: token.workspace_name,
      workspaceIcon: token.workspace_icon,
      owner: token.owner,
    });

    // Best-effort audit. Only non-secret metadata is recorded (never the token).
    await writeAuditLog(userId, {
      action: 'notion_connected',
      metadata: { workspaceId: token.workspace_id ?? null },
    });

    res.redirect(302, buildRedirectUrl({ notion: 'connected' }));
  } catch (error) {
    const reason = safeErrorReason(error);
    console.error(`[notion] OAuth callback failed (reason=${reason}).`);
    res.redirect(302, buildRedirectUrl({ notion: 'error', reason }));
  }
}

/**
 * `GET /api/notion/connection`
 *
 * Returns the caller's connection status WITHOUT the access token.
 */
export async function getNotionConnectionStatus(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const summary = await getConnectionSummary(userId);
    res.json(summary);
  } catch {
    console.error('[notion] Could not load the connection status.');
    res.status(500).json({ error: 'Could not load the Notion connection' });
  }
}

/**
 * `DELETE /api/notion/connection`
 *
 * Removes the caller's stored connection (disconnect).
 */
export async function disconnectNotion(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const removed = await deleteConnection(userId);

    // Best-effort audit, written only when a connection actually existed.
    if (removed) {
      await writeAuditLog(userId, { action: 'notion_disconnected' });
    }

    res.json({ connected: false });
  } catch {
    console.error('[notion] Could not disconnect the Notion connection.');
    res.status(500).json({ error: 'Could not disconnect Notion' });
  }
}
