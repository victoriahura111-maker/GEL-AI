import { listTasksForSync } from '../tasks/repository';
import { getSyncState } from './syncStateRepository';
import type { SyncDirection } from './syncStateRepository';

/**
 * Phase 16 — sync status read model for `GET /api/sync/status`.
 *
 * Combines the per-user watermark/error state (`user_sync_state`) with a count
 * of the local mirror rows by their `sync_status`. A task is:
 *  - **synced** — `sync_status = 'synced'`;
 *  - **error**  — `sync_status = 'error'`;
 *  - **pending** — anything else (never synced, in flight, or unknown), which
 *    includes local-only tasks that have no Notion page yet.
 *
 * Only safe messages are surfaced — never a Notion token or raw payload.
 */

export interface SyncStatusCounts {
  synced: number;
  pending: number;
  error: number;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  lastDirection: SyncDirection | null;
  lastError: string | null;
  counts: SyncStatusCounts;
  recentErrors: string[];
}

export async function getSyncStatus(userId: string): Promise<SyncStatus> {
  const state = await getSyncState(userId);

  let tasks = [] as Awaited<ReturnType<typeof listTasksForSync>>;
  try {
    tasks = await listTasksForSync(userId);
  } catch {
    tasks = [];
  }

  const counts: SyncStatusCounts = { synced: 0, pending: 0, error: 0 };
  for (const task of tasks) {
    if (task.sync_status === 'synced') counts.synced += 1;
    else if (task.sync_status === 'error') counts.error += 1;
    else counts.pending += 1;
  }

  return {
    lastSyncedAt: state.lastSyncedAt,
    lastDirection: state.lastDirection,
    lastError: state.lastError,
    counts,
    recentErrors: state.recentErrors,
  };
}
