import cors from 'cors';
import type { CorsOptions } from 'cors';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { config } from '../config';

/**
 * Phase 17 — transport and browser-boundary hardening.
 *
 * ## Helmet
 *
 * Sensible defaults for a **JSON API**. Content-Security-Policy is disabled
 * because this server never returns HTML documents (the SPA is served elsewhere);
 * `Cross-Origin-Resource-Policy` is set to `cross-origin` so the separately
 * hosted SPA is allowed to read responses. `X-Powered-By` is disabled in the app
 * factory, not here.
 *
 * ## CORS
 *
 * Only the configured origin(s) (`CORS_ORIGIN`, defaulting to `APP_URL`) are
 * allowed, with credentials, an explicit method list, and the `Authorization` /
 * `Content-Type` request headers. Requests without an `Origin` (curl, server to
 * server, same-origin) are allowed. A browser request carrying a disallowed
 * `Origin` is rejected with `403`, and preflight (`OPTIONS`) is answered by the
 * `cors` middleware with `204 No Content` and the `Access-Control-*` headers.
 */

/** Helmet with JSON-API-appropriate settings. */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
});

const allowedOrigins = new Set(config.corsOrigins);

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: not a browser cross-origin request; allow it.
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, allowedOrigins.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

const corsHandler = cors(corsOptions);

/**
 * Rejects a disallowed browser origin with `403` before the `cors` middleware
 * runs, then delegates to `cors` for allowed origins (including preflight).
 */
export const corsMiddleware: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  corsHandler(req, res, next);
};

/** Exposed for tests. */
export const allowedCorsOrigins: readonly string[] = config.corsOrigins;
