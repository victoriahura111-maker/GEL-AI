import type { NextFunction, Request, Response } from 'express';

/** Shape of the HTTP errors thrown by `body-parser` (and similar). */
interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    next(err);
    return;
  }

  const candidate = err as HttpLikeError;
  const status = candidate?.status ?? candidate?.statusCode;

  // Client input errors are mapped to their public status with a fixed message.
  // The raw error text is never logged (a body-parser message can echo the body).
  if (status === 413) {
    console.error('[error] request payload too large');
    res.status(413).json({ error: 'Payload Too Large' });
    return;
  }

  if (status === 400) {
    console.error('[error] malformed request body');
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(`[error] ${message}`);
  res.status(500).json({ error: 'Internal Server Error' });
}
