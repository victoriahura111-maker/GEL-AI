import type { NextFunction, Request, Response } from 'express';

/**
 * Phase 17 — request logging hygiene.
 *
 * Logs one line per completed request with: method, path (with sensitive query
 * parameters redacted), status, duration, and the authenticated user id. It
 * **never** logs the `Authorization`/`Cookie` headers, request bodies (which may
 * carry tokens), or query-string secrets.
 */

/** Query-parameter names whose values must never appear in logs. */
const SENSITIVE_PARAM =
  /^(token|access_token|refresh_token|id_token|api[_-]?key|secret|client_secret|code|state|password|authorization|cookie)$/i;

/** JWT-shaped strings (`eyJ...`). */
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

/** `Bearer <token>` sequences. */
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

/**
 * Redacts secret-looking substrings from an arbitrary string: `Bearer` tokens
 * and JWT-shaped values. Safe to call on any value; non-secrets pass through.
 */
export function redact(value: string): string {
  if (!value) return value;
  return value.replace(BEARER, '$1[REDACTED]').replace(JWT_LIKE, '[REDACTED]');
}

/**
 * Redacts sensitive query parameters from a request URL (path + query) and then
 * applies {@link redact} to catch any token-shaped values left behind.
 */
export function redactUrl(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf('?');
  if (queryIndex === -1) {
    return redact(originalUrl);
  }

  const path = originalUrl.slice(0, queryIndex);
  const rawQuery = originalUrl.slice(queryIndex + 1);

  const output = new URLSearchParams();
  new URLSearchParams(rawQuery).forEach((value, key) => {
    output.append(key, SENSITIVE_PARAM.test(key) ? '[REDACTED]' : value);
  });

  const query = output.toString();
  return redact(query ? `${path}?${query}` : path);
}

/** Express middleware that logs a single, redacted line per completed request. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const userId = req.user?.id ?? 'anonymous';
    console.log(
      `[http] ${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ${durationMs}ms user=${userId}`
    );
  });
  next();
}
