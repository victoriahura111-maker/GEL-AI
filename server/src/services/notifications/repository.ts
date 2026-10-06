import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';

/**
 * Phase 14 — server-side repository for `public.assistant_notifications`.
 *
 * Design rules, matching the other repositories:
 *  - Every query is scoped with `.eq('user_id', userId)`; `userId` always comes
 *    from the authenticated request, never the client body.
 *  - When Supabase is unconfigured reads degrade to `[]`/`0`/`null` and writes
 *    return `null`/`0`, so the server can still boot with safe defaults.
 */

const TABLE = 'assistant_notifications';

export type NotificationStatus = 'unread' | 'read';

/** Row shape of `public.assistant_notifications`. */
export interface NotificationRecord {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  status: NotificationStatus;
  task_id: string | null;
  notion_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
  updated_at: string;
}

/** Raised when a notification database operation fails. */
export class NotificationRepositoryError extends Error {
  constructor(operation: string, message: string) {
    super(`[notifications] ${operation} failed: ${message}`);
    this.name = 'NotificationRepositoryError';
  }
}

/** Input for {@link createNotification}. */
export interface CreateNotificationInput {
  type: string;
  title: string;
  body?: string | null;
  channel?: string;
  taskId?: string | null;
  notionUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Filters accepted by {@link listNotifications}. */
export interface ListNotificationsFilters {
  status?: NotificationStatus;
  type?: string;
  limit?: number;
  /** Opaque keyset cursor: the `created_at` of the last row of the prior page. */
  cursor?: string | null;
}

/** Result of {@link listNotifications}. */
export interface ListNotificationsResult {
  notifications: NotificationRecord[];
  /** Pass back as `cursor` to fetch the next page; `null` when exhausted. */
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function client(): SupabaseClient | null {
  return supabaseAdmin;
}

/** Inserts an `unread` notification owned by `userId`. */
export async function createNotification(
  userId: string,
  input: CreateNotificationInput
): Promise<NotificationRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .insert({
      user_id: userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      channel: input.channel ?? 'in_app',
      status: 'unread',
      task_id: input.taskId ?? null,
      notion_url: input.notionUrl ?? null,
      metadata: input.metadata ?? null,
    })
    .select('*')
    .single();

  if (error) {
    throw new NotificationRepositoryError('createNotification', error.message);
  }

  return (data as NotificationRecord | null) ?? null;
}

/**
 * Lists the caller's notifications, newest first, with optional filters and
 * keyset pagination. Returns `{ notifications, nextCursor }`; `nextCursor` is
 * non-null only when a full page was returned (i.e. more rows may exist).
 */
export async function listNotifications(
  userId: string,
  filters: ListNotificationsFilters = {}
): Promise<ListNotificationsResult> {
  const admin = client();
  if (!admin) return { notifications: [], nextCursor: null };

  let query = admin.from(TABLE).select('*').eq('user_id', userId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.cursor) query = query.lt('created_at', filters.cursor);

  const capped = Math.min(Math.max(filters.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(capped);

  if (error) {
    throw new NotificationRepositoryError('listNotifications', error.message);
  }

  const notifications = (data as NotificationRecord[] | null) ?? [];
  const nextCursor =
    notifications.length === capped
      ? notifications[notifications.length - 1].created_at
      : null;

  return { notifications, nextCursor };
}

/** Counts the caller's `unread` notifications (the bell badge). */
export async function countUnread(userId: string): Promise<number> {
  const admin = client();
  if (!admin) return 0;

  const { data, error } = await admin
    .from(TABLE)
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'unread');

  if (error) {
    throw new NotificationRepositoryError('countUnread', error.message);
  }

  return ((data as unknown[] | null) ?? []).length;
}

/**
 * Marks one owned notification `read`. Returns the updated row, or `null` when
 * no owned row matched (a foreign id is indistinguishable from a missing one).
 */
export async function markRead(
  userId: string,
  id: string
): Promise<NotificationRecord | null> {
  const admin = client();
  if (!admin) return null;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'read', read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new NotificationRepositoryError('markRead', error.message);
  }

  return (data as NotificationRecord | null) ?? null;
}

/** Marks every `unread` notification of the caller `read`; returns the count. */
export async function markAllRead(userId: string): Promise<number> {
  const admin = client();
  if (!admin) return 0;

  const { data, error } = await admin
    .from(TABLE)
    .update({ status: 'read', read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'unread')
    .select('id');

  if (error) {
    throw new NotificationRepositoryError('markAllRead', error.message);
  }

  return ((data as unknown[] | null) ?? []).length;
}
