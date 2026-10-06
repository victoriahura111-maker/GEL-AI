import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';

/**
 * Phase 16 — per-user sync watermark / status persistence
 * (`public.user_sync_state`, migration `0011_user_sync_state.sql`).
 *
 * The engine stores, per user, the instant of the last *successful* pull pass
 * (the watermark used to filter Notion's `/databases/:id/query` by
 * `last_edited_time after`), the last direction, and a bounded list of recent
 * user-safe error messages.
 *
 * Every function is deliberately **throw-free**: sync is best-effort background
 * work and a state-write failure must never crash a tick or a request. A
 * Supabase-unconfigured deployment degrades to `null`/no-op. All access is
 * `user_id`-scoped and the table has per-user RLS.
 */

const TABLE = 'user_sync_state';

/** Bounded number of recent errors retained per user. */
export const MAX_RECENT_ERRORS = 10;

export type SyncDirection = 'both' | 'pull' | 'push';

/** Persisted sync state (camelCase; never exposes internal columns). */
export interface SyncState {
  lastSyncedAt: string | null;
  lastDirection: SyncDirection | null;
  lastError: string | null;
  recentErrors: string[];
}

/** Input for {@link setSyncState}; all fields optional (partial update). */
export interface SetSyncStateInput {
  lastSyncedAt?: string | null;
  lastDirection?: SyncDirection | null;
  lastError?: string | null;
  recentErrors?: string[];
}

const EMPTY_STATE: SyncState = {
  lastSyncedAt: null,
  lastDirection: null,
  lastError: null,
  recentErrors: [],
};

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Coerces a `jsonb` column into a string array, tolerating a JSON string. */
function toErrorList(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value.trim() ? [value.trim()] : [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT_ERRORS);
}

/** Reads the caller's sync state, or an empty state when absent/unconfigured. */
export async function getSyncState(userId: string): Promise<SyncState> {
  const admin = client();
  if (!admin) return { ...EMPTY_STATE, recentErrors: [] };

  try {
    const { data, error } = await admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return { ...EMPTY_STATE, recentErrors: [] };

    const record = data as Record<string, unknown>;
    const direction = record.last_direction;
    return {
      lastSyncedAt: typeof record.last_synced_at === 'string' ? record.last_synced_at : null,
      lastDirection:
        direction === 'both' || direction === 'pull' || direction === 'push' ? direction : null,
      lastError: typeof record.last_error === 'string' ? record.last_error : null,
      recentErrors: toErrorList(record.recent_errors),
    };
  } catch {
    return { ...EMPTY_STATE, recentErrors: [] };
  }
}

/**
 * Upserts the caller's sync state (one row per user). Only the fields present in
 * `input` are written; `last_synced_at` is left untouched when omitted so a
 * push-only run does not advance the pull watermark. Never throws.
 */
export async function setSyncState(
  userId: string,
  input: SetSyncStateInput
): Promise<SyncState | null> {
  const admin = client();
  if (!admin) return null;

  const payload: Record<string, unknown> = { user_id: userId };
  if (input.lastSyncedAt !== undefined) payload.last_synced_at = input.lastSyncedAt;
  if (input.lastDirection !== undefined) payload.last_direction = input.lastDirection;
  if (input.lastError !== undefined) payload.last_error = input.lastError;
  if (input.recentErrors !== undefined) {
    payload.recent_errors = input.recentErrors.slice(0, MAX_RECENT_ERRORS);
  }

  try {
    const { data, error } = await admin
      .from(TABLE)
      .upsert(payload, { onConflict: 'user_id' })
      .select('*')
      .single();

    if (error) {
      console.error('[sync] Could not persist sync state.');
      return null;
    }

    const record = (data as Record<string, unknown> | null) ?? null;
    if (!record) return null;
    return {
      lastSyncedAt: typeof record.last_synced_at === 'string' ? record.last_synced_at : null,
      lastDirection:
        record.last_direction === 'both' ||
        record.last_direction === 'pull' ||
        record.last_direction === 'push'
          ? record.last_direction
          : null,
      lastError: typeof record.last_error === 'string' ? record.last_error : null,
      recentErrors: toErrorList(record.recent_errors),
    };
  } catch {
    console.error('[sync] Could not persist sync state.');
    return null;
  }
}
