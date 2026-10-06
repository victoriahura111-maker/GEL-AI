import { apiRequest } from './api';

/**
 * Phase 16 — typed wrappers around the `/api/sync` endpoints. Every call goes
 * through `apiRequest`, which attaches the Supabase Bearer token; the server
 * scopes all work to the authenticated user and never returns a Notion token or
 * raw payload.
 */

export type SyncDirection = 'both' | 'pull' | 'push';

export interface SyncPullCounts {
  created: number;
  updated: number;
  skipped: number;
}

export interface SyncPushCounts {
  updated: number;
  failed: number;
}

/** A safe, user-displayable sync error (no tokens or raw payloads). */
export interface SyncError {
  scope: string;
  message: string;
}

/** The typed summary returned by `POST /api/sync`. */
export interface SyncSummary {
  direction: SyncDirection;
  pulled: SyncPullCounts;
  pushed: SyncPushCounts;
  errors: SyncError[];
  startedAt: string;
  finishedAt: string;
}

export interface SyncStatusCounts {
  synced: number;
  pending: number;
  error: number;
}

/** The read model returned by `GET /api/sync/status`. */
export interface SyncStatus {
  lastSyncedAt: string | null;
  lastDirection: SyncDirection | null;
  lastError: string | null;
  counts: SyncStatusCounts;
  recentErrors: string[];
}

/** `POST /api/sync` — run a manual sync (defaults to `both`). */
export function runSync(direction: SyncDirection = 'both'): Promise<SyncSummary> {
  return apiRequest<SyncSummary>('/api/sync', {
    method: 'POST',
    body: JSON.stringify({ direction }),
  });
}

/** `GET /api/sync/status` — last sync time, per-status counts, recent errors. */
export function fetchSyncStatus(): Promise<SyncStatus> {
  return apiRequest<SyncStatus>('/api/sync/status');
}
