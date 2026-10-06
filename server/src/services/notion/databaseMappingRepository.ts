import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import type { NotionDatabasePurpose } from '../../validators/notionDatabase';

/**
 * Server-side repository for `public.notion_database_mappings` (Phase 8).
 *
 * Maps a user's Notion databases to an application "purpose" and nominates one
 * as the default. Design rules (enforced by every function here):
 *  - Every query is scoped by `.eq('user_id', userId)`. `userId` always comes
 *    from the authenticated request, never the client body — defense-in-depth on
 *    top of RLS, which the service-role client bypasses.
 *  - When Supabase is unconfigured, read functions degrade gracefully (`[]`)
 *    while writes throw a typed `not_configured` error (routes map it to 503).
 */

const TABLE = 'notion_database_mappings';

/** Row shape of `public.notion_database_mappings`. */
export interface NotionDatabaseMappingRecord {
  id: string;
  user_id: string;
  notion_database_id: string;
  database_title: string | null;
  purpose: NotionDatabasePurpose | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Domain shape returned to callers (camelCase, no internal columns). */
export interface NotionDatabaseMapping {
  notionDatabaseId: string;
  databaseTitle: string | null;
  purpose: NotionDatabasePurpose | null;
  isDefault: boolean;
}

/** Input for {@link upsertMapping}. */
export interface UpsertMappingInput {
  notionDatabaseId: string;
  databaseTitle?: string | null;
  purpose: NotionDatabasePurpose;
  /** When omitted the existing default flag is preserved (defaults to false on insert). */
  isDefault?: boolean;
}

/** Raised when a mapping write/read fails. */
export class DatabaseMappingRepositoryError extends Error {
  readonly code: 'not_configured' | 'query_failed';

  constructor(message: string, code: 'not_configured' | 'query_failed') {
    super(`[notion] ${message}`);
    this.name = 'DatabaseMappingRepositoryError';
    this.code = code;
  }
}

/** Returns the admin client, or `null` when Supabase is not configured. */
function client(): SupabaseClient | null {
  return supabaseAdmin;
}

function toMapping(record: NotionDatabaseMappingRecord): NotionDatabaseMapping {
  return {
    notionDatabaseId: record.notion_database_id,
    databaseTitle: record.database_title,
    purpose: record.purpose,
    // Coerce defensively: the in-memory fake (and a not-yet-migrated row) may
    // omit the flag, which must still read as `false`.
    isDefault: record.is_default === true,
  };
}

/** Fetches one of the caller's mapping rows, or `null` when absent. */
async function findMapping(
  admin: SupabaseClient,
  userId: string,
  notionDatabaseId: string
): Promise<NotionDatabaseMappingRecord | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('notion_database_id', notionDatabaseId)
    .maybeSingle();

  if (error) {
    throw new DatabaseMappingRepositoryError(`findMapping failed: ${error.message}`, 'query_failed');
  }

  return (data as NotionDatabaseMappingRecord | null) ?? null;
}

/** Clears every default flag for the user so at most one default can remain. */
async function clearDefaults(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin
    .from(TABLE)
    .update({ is_default: false })
    .eq('user_id', userId)
    .eq('is_default', true);

  if (error) {
    throw new DatabaseMappingRepositoryError(`clearDefaults failed: ${error.message}`, 'query_failed');
  }
}

/** Lists the caller's mappings (default first, then oldest first). */
export async function listMappings(userId: string): Promise<NotionDatabaseMapping[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    throw new DatabaseMappingRepositoryError(`listMappings failed: ${error.message}`, 'query_failed');
  }

  return ((data as NotionDatabaseMappingRecord[] | null) ?? []).map(toMapping);
}

/** Lists the caller's mappings for a single purpose (used by later selection logic). */
export async function getMappingsByPurpose(
  userId: string,
  purpose: NotionDatabasePurpose
): Promise<NotionDatabaseMapping[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    throw new DatabaseMappingRepositoryError(
      `getMappingsByPurpose failed: ${error.message}`,
      'query_failed'
    );
  }

  return ((data as NotionDatabaseMappingRecord[] | null) ?? []).map(toMapping);
}

/**
 * Inserts or updates the caller's mapping for a Notion database (unique on
 * `user_id` + `notion_database_id`). When `isDefault` is true every other
 * mapping for the user is un-defaulted first, so at most one default exists.
 */
export async function upsertMapping(
  userId: string,
  input: UpsertMappingInput
): Promise<NotionDatabaseMapping> {
  const admin = client();
  if (!admin) {
    throw new DatabaseMappingRepositoryError('Supabase is not configured.', 'not_configured');
  }

  if (input.isDefault === true) {
    await clearDefaults(admin, userId);
  }

  const payload: Record<string, unknown> = {
    user_id: userId,
    notion_database_id: input.notionDatabaseId,
    database_title: input.databaseTitle ?? null,
    purpose: input.purpose,
  };
  // Omitting the flag preserves an existing default on update and lets the
  // database default (false) apply on insert.
  if (input.isDefault !== undefined) payload.is_default = input.isDefault;

  const { data, error } = await admin
    .from(TABLE)
    .upsert(payload, { onConflict: 'user_id,notion_database_id' })
    .select('*')
    .single();

  if (error) {
    throw new DatabaseMappingRepositoryError(`upsertMapping failed: ${error.message}`, 'query_failed');
  }

  const record = data as NotionDatabaseMappingRecord | null;
  if (!record) {
    throw new DatabaseMappingRepositoryError('upsertMapping returned no row.', 'query_failed');
  }
  return toMapping(record);
}

/**
 * Removes the caller's mapping for a Notion database. Returns `true` when a row
 * was removed; cross-user attempts match nothing and return `false`.
 */
export async function deleteMapping(userId: string, notionDatabaseId: string): Promise<boolean> {
  const admin = client();
  if (!admin) {
    throw new DatabaseMappingRepositoryError('Supabase is not configured.', 'not_configured');
  }

  const { data, error } = await admin
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('notion_database_id', notionDatabaseId)
    .select('id');

  if (error) {
    throw new DatabaseMappingRepositoryError(`deleteMapping failed: ${error.message}`, 'query_failed');
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Makes the caller's mapping for a Notion database the single default. Clears
 * all other defaults first. Returns the updated mapping, or `null` when the
 * caller has no mapping for that database.
 */
export async function setDefault(
  userId: string,
  notionDatabaseId: string
): Promise<NotionDatabaseMapping | null> {
  const admin = client();
  if (!admin) {
    throw new DatabaseMappingRepositoryError('Supabase is not configured.', 'not_configured');
  }

  // Only touch defaults when the caller actually has a mapping for this database,
  // so a stray id cannot clear an existing default.
  const existing = await findMapping(admin, userId, notionDatabaseId);
  if (!existing) return null;

  await clearDefaults(admin, userId);

  const { data, error } = await admin
    .from(TABLE)
    .update({ is_default: true })
    .eq('user_id', userId)
    .eq('notion_database_id', notionDatabaseId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new DatabaseMappingRepositoryError(`setDefault failed: ${error.message}`, 'query_failed');
  }

  const record = data as NotionDatabaseMappingRecord | null;
  return record ? toMapping(record) : null;
}
