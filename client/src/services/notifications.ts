import { apiRequest } from './api';

/**
 * Phase 14 — typed wrappers around the `/api/notifications` endpoints. Every
 * call goes through `apiRequest`, which attaches the Supabase Bearer token; the
 * server scopes all results to the authenticated user.
 */

export type NotificationStatus = 'unread' | 'read';

/** A notification row returned by the API (server-only fields are omitted). */
export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  status: NotificationStatus;
  task_id: string | null;
  notion_url: string | null;
  created_at: string;
  read_at: string | null;
  updated_at: string;
}

export interface NotificationListFilters {
  status?: NotificationStatus;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface NotificationListResult {
  notifications: AppNotification[];
  nextCursor: string | null;
}

/** Serialises defined filters into a query string (empty when none). */
export function buildNotificationQuery(filters: NotificationListFilters = {}): string {
  const params = new URLSearchParams();

  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
  if (filters.cursor) params.set('cursor', filters.cursor);

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** `GET /api/notifications` — the caller's notifications, newest first. */
export async function listNotifications(
  filters: NotificationListFilters = {}
): Promise<NotificationListResult> {
  return apiRequest<NotificationListResult>(`/api/notifications${buildNotificationQuery(filters)}`);
}

/** `GET /api/notifications/unread-count` — the bell badge count. */
export async function getUnreadCount(): Promise<number> {
  const response = await apiRequest<{ count: number }>('/api/notifications/unread-count');
  return response.count;
}

/** `POST /api/notifications/:id/read` — marks one owned notification read. */
export async function markRead(id: string): Promise<AppNotification> {
  const response = await apiRequest<{ notification: AppNotification }>(
    `/api/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST' }
  );
  return response.notification;
}

/** `POST /api/notifications/read-all` — marks every unread notification read. */
export async function markAllRead(): Promise<number> {
  const response = await apiRequest<{ updated: number }>('/api/notifications/read-all', {
    method: 'POST',
  });
  return response.updated;
}
