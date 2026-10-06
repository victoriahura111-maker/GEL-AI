import { config } from '../../config';
import { supabaseAdmin } from '../supabase';
import { getConnectionSummary } from '../notion/connectionRepository';

/**
 * Phase 16 — synchronization service surface.
 *
 * Re-exports the engine, the watermark repository, the status read model, the
 * cooldown guard, and the scheduler lifecycle. The `sync` controller depends on
 * this barrel so route tests can mock a single module.
 */

export { syncUser, SYNC_EPOCH, MAX_QUERY_PAGES } from './engine';
export type {
  SyncDirection,
  SyncSummary,
  SyncError,
  SyncPullCounts,
  SyncPushCounts,
  SyncUserOptions,
} from './engine';

export {
  getSyncState,
  setSyncState,
  MAX_RECENT_ERRORS,
} from './syncStateRepository';
export type { SyncState, SetSyncStateInput } from './syncStateRepository';

export { getSyncStatus } from './status';
export type { SyncStatus, SyncStatusCounts } from './status';

export {
  checkSyncCooldown,
  recordSyncAttempt,
  resetSyncCooldown,
} from './cooldown';
export type { CooldownDecision } from './cooldown';

export {
  startSyncScheduler,
  stopSyncScheduler,
  isSyncSchedulerRunning,
  DEFAULT_SYNC_USER_LIMIT,
} from './scheduler';

/**
 * True when synchronization can run at all: Supabase (storage) and Notion
 * (OAuth credentials) must both be configured. The HTTP layer maps `false` to
 * `503` so a misconfigured deployment fails loudly and safely.
 */
export function isSyncConfigured(): boolean {
  return config.isSupabaseConfigured && config.isNotionConfigured && Boolean(supabaseAdmin);
}

/**
 * True when the caller has a usable Notion connection. Never throws: a lookup
 * failure is treated as "not connected" so the route answers `409` instead of
 * `500`.
 */
export async function isNotionConnected(userId: string): Promise<boolean> {
  try {
    const summary = await getConnectionSummary(userId);
    return summary.connected === true;
  } catch {
    return false;
  }
}
