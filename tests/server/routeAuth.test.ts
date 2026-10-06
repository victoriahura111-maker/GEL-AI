import type { Router } from 'express';
import request from 'supertest';
import { createApp } from '../../server/src/app';
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
} from '../../server/src/routes';

/**
 * Phase 17 — authentication enforcement across the API surface.
 *
 * The routes are enumerated from the *real* routers (not a hand-written list),
 * so a future route added to any router is automatically probed. Every route
 * except the two documented public ones must reject an unauthenticated request
 * with 401 (missing/invalid token) or 503 (auth not configured) — never 2xx and
 * never a resource payload.
 */

interface MountedRouter {
  prefix: string;
  router: Router;
}

const MOUNTS: MountedRouter[] = [
  { prefix: '/health', router: healthRouter },
  { prefix: '/api/auth', router: authRouter },
  { prefix: '/api/assistant', router: assistantRouter },
  { prefix: '/api/conversations', router: conversationsRouter },
  { prefix: '/api/notion', router: notionRouter },
  { prefix: '/api/tasks', router: tasksRouter },
  { prefix: '/api/reminders', router: remindersRouter },
  { prefix: '/api/notifications', router: notificationsRouter },
  { prefix: '/api/sync', router: syncRouter },
];

interface RouteCase {
  key: string;
  method: string;
  path: string;
}

/** Enumerates a router's `(method, path)` pairs from its internal stack. */
function routesOf(router: Router): Array<{ method: string; path: string }> {
  const stack =
    (
      router as unknown as {
        stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
      }
    ).stack ?? [];

  const out: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: routePath });
    }
  }
  return out;
}

function collectCases(): RouteCase[] {
  const cases: RouteCase[] = [];
  for (const { prefix, router } of MOUNTS) {
    for (const { method, path } of routesOf(router)) {
      const suffix = path === '/' ? '' : path;
      const full = `${prefix}${suffix}` || '/';
      cases.push({ key: `${method} ${full}`, method, path: full });
    }
  }
  return cases;
}

/** Replaces `:params` with a concrete placeholder for probing. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'test-id');
}

const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /api/notion/oauth/callback',
]);

describe('route authentication enforcement', () => {
  const cases = collectCases();

  it('enumerates every mounted route (guard against untested additions)', () => {
    // Sanity: all three early routers and their routes are discovered.
    expect(cases.length).toBeGreaterThanOrEqual(27);
    expect(cases.some((c) => c.key === 'GET /health')).toBe(true);
    expect(cases.some((c) => c.key === 'GET /api/notion/oauth/callback')).toBe(true);
  });

  it.each(cases.filter((c) => !PUBLIC_ROUTES.has(c.key)))(
    'rejects an unauthenticated %s',
    async ({ method, path }) => {
      const app = createApp();
      const response = await request(app)[
        method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
      ](concretePath(path));

      expect([401, 503]).toContain(response.status);
      // No resource payload is ever returned to an unauthenticated caller.
      expect(response.body.error).toBeTruthy();
    }
  );

  it('keeps /health public', async () => {
    const response = await request(createApp()).get('/health');
    expect(response.status).toBe(200);
  });

  it('keeps the Notion OAuth callback public (trust derives from signed state)', async () => {
    const response = await request(createApp()).get('/api/notion/oauth/callback');
    expect(response.status).not.toBe(401);
    // A malformed/missing state redirects back to the app with a safe reason.
    expect([302, 400]).toContain(response.status);
  });
});
