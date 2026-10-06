import { rateLimit } from 'express-rate-limit';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { config } from '../config';

/**
 * Phase 17 — request rate limiting.
 *
 * The limiters are keyed by the authenticated user id when available and fall
 * back to the client IP (IPv6-normalised via `ipKeyGenerator`). They emit the
 * standard `RateLimit-*` headers and a `Retry-After` header on a `429`, with a
 * small user-safe JSON body.
 *
 * ## Test behaviour
 *
 * Existing suites make many requests through the app factory from the same IP;
 * a real limiter would make them flaky. When `NODE_ENV === 'test'` every limiter
 * built here is skipped (`skip: () => true`) unless it is explicitly built with
 * `enabledInTest: true`. Tests that exercise the limiter build one directly with
 * `createRateLimiter({ windowMs, max, enabledInTest: true })`.
 */

export interface RateLimiterSettings {
  /** Window length in milliseconds. Defaults to `RATE_LIMIT_WINDOW_MS`. */
  windowMs?: number;
  /** Maximum requests per window. Defaults to `RATE_LIMIT_MAX`. */
  max?: number;
  /**
   * Build a limiter that runs even under `NODE_ENV === 'test'`. Used by the
   * rate-limit tests; production call sites leave it unset.
   */
  enabledInTest?: boolean;
}

/** Shared key generator: authenticated user id first, then the IP address. */
function rateLimitKey(req: Request): string {
  const userId = req.user?.id;
  if (userId) {
    return `user:${userId}`;
  }

  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  // Normalise IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4` → `1.2.3.4`) so the
  // same client is never counted twice under two spellings.
  return `ip:${ip.replace(/^::ffff:/, '')}`;
}

/** Seconds to wait before retrying, derived from the limiter's reset time. */
function retryAfterSeconds(res: Response): number {
  const resetTime = res.getHeader('RateLimit-Reset');
  const resetEpochSeconds = typeof resetTime === 'string' ? Number(resetTime) : NaN;
  if (Number.isFinite(resetEpochSeconds)) {
    return Math.max(1, Math.ceil(resetEpochSeconds - Date.now() / 1000));
  }
  return Math.max(1, Math.ceil(config.rateLimit.windowMs / 1000));
}

/**
 * Builds a rate limiter with the given settings. Exported so tests can create a
 * limiter with a tiny window/max and assert the `429` contract.
 */
export function createRateLimiter(settings: RateLimiterSettings = {}): RateLimitRequestHandler {
  const windowMs = settings.windowMs ?? config.rateLimit.windowMs;
  const max = settings.max ?? config.rateLimit.max;
  const disabledInTest = config.isTest && settings.enabledInTest !== true;

  return rateLimit({
    windowMs,
    limit: max,
    // `draft-7` emits the standard `RateLimit` / `RateLimit-Policy` headers and
    // (on 429) `Retry-After`, without the legacy `X-RateLimit-*` headers.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => disabledInTest,
    keyGenerator: rateLimitKey,
    handler: (_req: Request, res: Response) => {
      const retryAfter = retryAfterSeconds(res);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
      });
    },
  });
}

/** Applies to every `/api/*` route. */
export const globalLimiter = createRateLimiter();

/** Stricter limit for the AI assistant endpoints (they call an external model). */
export const assistantLimiter = createRateLimiter({ max: config.rateLimit.assistantMax });

/** Limit for the manual Notion sync endpoint. */
export const syncLimiter = createRateLimiter({ max: config.rateLimit.syncMax });

/** Limit for the Notion integration endpoints (they proxy to the Notion API). */
export const notionLimiter = createRateLimiter({ max: config.rateLimit.notionMax });
