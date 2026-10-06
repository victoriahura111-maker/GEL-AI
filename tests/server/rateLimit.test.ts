import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createRateLimiter, globalLimiter } from '../../server/src/middleware/rateLimit';

/**
 * Phase 17 — rate limiter contract.
 *
 * The exported limiters are skipped under `NODE_ENV === 'test'`; these tests
 * build a limiter with `enabledInTest: true` and a tiny max to exercise the real
 * `429` behaviour, and separately assert the test-env skip.
 */

function appWithLimiter(limiter: ReturnType<typeof createRateLimiter>) {
  const app = express();
  app.set('trust proxy', false);
  app.get('/limited', limiter, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

describe('rate limiting', () => {
  it('allows requests up to the limit then returns 429 with Retry-After', async () => {
    const app = appWithLimiter(
      createRateLimiter({ windowMs: 60000, max: 2, enabledInTest: true })
    );

    const first = await request(app).get('/limited');
    const second = await request(app).get('/limited');
    const third = await request(app).get('/limited');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect(third.body).toEqual({
      error: 'Too many requests',
      message: expect.stringContaining('Rate limit exceeded'),
    });
  });

  it('emits the standard RateLimit-* headers', async () => {
    const app = appWithLimiter(
      createRateLimiter({ windowMs: 60000, max: 5, enabledInTest: true })
    );

    const response = await request(app).get('/limited');

    // draft-7 style: `RateLimit` and `RateLimit-Policy`.
    const headerNames = Object.keys(response.headers);
    expect(
      headerNames.some((name) => name.toLowerCase() === 'ratelimit') ||
        headerNames.some((name) => name.toLowerCase() === 'ratelimit-policy')
    ).toBe(true);
  });

  it('keys by the authenticated user id so users do not share a bucket', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const header = req.headers['x-user'];
      (req as { user?: { id: string; email: string | null } }).user = {
        id: typeof header === 'string' ? header : 'anonymous',
        email: null,
      };
      next();
    });
    app.get(
      '/limited',
      createRateLimiter({ windowMs: 60000, max: 1, enabledInTest: true }),
      (_req: Request, res: Response) => res.json({ ok: true })
    );

    const userA1 = await request(app).get('/limited').set('x-user', 'user-a');
    const userA2 = await request(app).get('/limited').set('x-user', 'user-a');
    const userB1 = await request(app).get('/limited').set('x-user', 'user-b');

    expect(userA1.status).toBe(200);
    expect(userA2.status).toBe(429);
    // A different user has an independent bucket.
    expect(userB1.status).toBe(200);
  });

  it('skips the exported limiters in the test environment', async () => {
    const app = appWithLimiter(globalLimiter);

    for (let i = 0; i < 15; i += 1) {
      const response = await request(app).get('/limited');
      expect(response.status).toBe(200);
    }
  });
});
