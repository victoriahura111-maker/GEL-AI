import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import { decrypt, encrypt } from '../../utils/encryption';
import type { NotionOwner } from './oauth';

/**
 * Server-side repository for `public.notion_connections`.
 *
 * The access token is stored encrypted (AES-256-GCM, see `utils/encryption`) and
 * only ever decrypted inside {@link getConnection} for internal server use.
 * {@link getConnectionSummary} — the shape exposed to the browser — never reads
 * or returns the token column.
 *
 * Every query is scoped by `user_id`. Reads return `null`/`{ connected: false }`
 * when Supabase is unconfigured so the status endpoint degrades gracefully.
 */

const TABLE = 'notion_connections';

/** Row shape of `public.notion_connections`. */
export interface NotionConnectionRecord {
  id: string;
  user_id: string;
  access_token_encrypted: string;
  bot_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_icon: string | null;
  owner: NotionOwner | null;
  created_at: string;
  updated_at: string;
}

/** Input for {@link upsertConnection}; the token is plaintext and encrypted here. */
export interface UpsertConnectionInput {
  accessToken: string;
  botId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  owner: NotionOwner | null;
}

/** Internal shape including the decrypted token (server use only). */
export interface NotionConnection {
  userId: string;
  accessToken: string;
  botId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  owner: NotionOwner | null;
  createdAt: string;
}

/** Browser-safe connection status. Never contains the access token. */
export interface NotionConnectionSummary {
  connected: boolean;
  workspaceName: string | null;
  workspaceIcon: string | null;
  workspaceId: string | null;
  connectedAt: string | null;
}

/** Raised when a write/read against the connection table fails. */
export class NotionConnectionRepositoryError extends Error {
  readonly code: 'not_configured' | 'query_failed';

  constructor(message: string, code: 'not_configured' | 'query_failed') {
    super(`[notion] ${message}`);
    this.name = 'NotionConnectionRepositoryError';
    this.code = code;
  }
}

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Empty, browser-safe summary used when unconfigured or not connected. */
function emptySummary(): NotionConnectionSummary {
  return {
    connected: false,
    workspaceName: null,
    workspaceIcon: null,
    workspaceId: null,
    connectedAt: null,
  };
}

/**
 * Inserts or replaces the caller's connection (one per user, upsert on
 * `user_id`). The plaintext token is encrypted before it leaves this function.
 */
export async function upsertConnection(
  userId: string,
  input: UpsertConnectionInput
): Promise<void> {
  const admin = client();
  if (!admin) {
    throw new NotionConnectionRepositoryError(
      'Supabase is not configured.',
      'not_configured'
    );
  }

  const { error } = await admin
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        access_token_encrypted: encrypt(input.accessToken),
        bot_id: input.botId,
        workspace_id: input.workspaceId,
        workspace_name: input.workspaceName,
        workspace_icon: input.workspaceIcon,
        owner: input.owner,
      },
      { onConflict: 'user_id' }
    )
    .select('*')
    .single();

  if (error) {
    throw new NotionConnectionRepositoryError(
      `upsertConnection failed: ${error.message}`,
      'query_failed'
    );
  }
}

/**
 * Returns the caller's connection with the token DECRYPTED, for internal server
 * use only. Returns `null` when unconfigured or not connected.
 */
export async function getConnection(userId: string): Promise<NotionConnection | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new NotionConnectionRepositoryError(
      `getConnection failed: ${error.message}`,
      'query_failed'
    );
  }

  const record = (data as NotionConnectionRecord | null) ?? null;
  if (!record) return null;

  return {
    userId: record.user_id,
    accessToken: decrypt(record.access_token_encrypted),
    botId: record.bot_id,
    workspaceId: record.workspace_id,
    workspaceName: record.workspace_name,
    workspaceIcon: record.workspace_icon,
    owner: record.owner,
    createdAt: record.created_at,
  };
}

/**
 * Returns the browser-safe connection status. Deliberately selects only the
 * non-secret columns so the token can never be read into an API response.
 */
export async function getConnectionSummary(userId: string): Promise<NotionConnectionSummary> {
  const admin = client();
  if (!admin) return emptySummary();

  const { data, error } = await admin
    .from(TABLE)
    .select('workspace_id, workspace_name, workspace_icon, created_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new NotionConnectionRepositoryError(
      `getConnectionSummary failed: ${error.message}`,
      'query_failed'
    );
  }

  const record = (data as Pick<
    NotionConnectionRecord,
    'workspace_id' | 'workspace_name' | 'workspace_icon' | 'created_at'
  > | null) ?? null;

  if (!record) return emptySummary();

  return {
    connected: true,
    workspaceName: record.workspace_name,
    workspaceIcon: record.workspace_icon,
    workspaceId: record.workspace_id,
    connectedAt: record.created_at,
  };
}

/** Deletes the caller's connection. Returns `true` when a row was removed. */
export async function deleteConnection(userId: string): Promise<boolean> {
  const admin = client();
  if (!admin) return false;

  const { data, error } = await admin
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new NotionConnectionRepositoryError(
      `deleteConnection failed: ${error.message}`,
      'query_failed'
    );
  }

  return Array.isArray(data) && data.length > 0;
}

/**
 * Returns the ids of users with a stored Notion connection, bounded by `limit`.
 *
 * Used only by the Phase 16 periodic sync scheduler to enumerate the users it
 * should reconcile. Deliberately selects the non-secret `user_id` column only —
 * the token is never read. Returns `[]` when Supabase is unconfigured.
 */
export async function listConnectedUserIds(limit = 500): Promise<string[]> {
  const admin = client();
  if (!admin) return [];

  const { data, error } = await admin.from(TABLE).select('user_id').limit(limit);

  if (error) {
    throw new NotionConnectionRepositoryError(
      `listConnectedUserIds failed: ${error.message}`,
      'query_failed'
    );
  }

  return ((data as Array<{ user_id?: unknown }> | null) ?? [])
    .map((row) => (typeof row.user_id === 'string' ? row.user_id : null))
    .filter((id): id is string => id !== null);
}
