import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { supabaseAdmin } from '../services/supabase';

/**
 * Express middleware that verifies the caller's Supabase access token.
 *
 * - 503 when Supabase is not configured.
 * - 401 when the Authorization header is missing or the token is invalid.
 * - On success attaches `req.user` = { id, email } and calls `next()`.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (!config.isSupabaseConfigured || !supabaseAdmin) {
    res.status(503).json({ error: 'Authentication is not configured' });
    return;
  }

  const authorization = req.headers.authorization;
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.user = {
      id: data.user.id,
      email: data.user.email ?? null,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
