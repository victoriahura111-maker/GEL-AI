import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getUnreadCount,
  listNotifications,
  markAllRead as markAllReadService,
  markRead as markReadService,
} from '../services/notifications';
import type { AppNotification } from '../services/notifications';

/**
 * Phase 14 — notification-center state.
 *
 * Fetches on mount and then polls (default every 30s), cleaning up the interval
 * on unmount. The poll can be paused with `enabled: false`. Exposes the list,
 * the unread count, a manual `refresh`, and the two read mutations (applied
 * optimistically to the local list).
 */

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface UseNotificationsOptions {
  /** Poll cadence in ms. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** How many notifications to list. Defaults to 20. */
  listLimit?: number;
  /** When false, no fetch or poll runs (e.g. signed out). */
  enabled?: boolean;
}

export interface UseNotificationsResult {
  notifications: AppNotification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export function useNotifications(options: UseNotificationsOptions = {}): UseNotificationsResult {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    listLimit = 20,
    enabled = true,
  } = options;

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  // Mirror of the latest list so `markRead` can decide whether to decrement the
  // badge without relying on a stale closure.
  const latest = useRef<AppNotification[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    latest.current = notifications;
  }, [notifications]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [list, count] = await Promise.all([
        listNotifications({ limit: listLimit }),
        getUnreadCount(),
      ]);
      if (!mounted.current) return;
      setNotifications(list.notifications);
      setUnreadCount(count);
      setError(null);
    } catch {
      if (mounted.current) setError('Could not load notifications.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [enabled, listLimit]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [enabled, pollIntervalMs, refresh]);

  const markRead = useCallback(async (id: string) => {
    const wasUnread = latest.current.find((item) => item.id === id)?.status === 'unread';
    try {
      const updated = await markReadService(id);
      if (!mounted.current) return;
      setNotifications((current) => current.map((item) => (item.id === id ? updated : item)));
      if (wasUnread) setUnreadCount((current) => Math.max(0, current - 1));
    } catch {
      if (mounted.current) setError('Could not update the notification.');
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await markAllReadService();
      if (!mounted.current) return;
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((item) =>
          item.status === 'unread' ? { ...item, status: 'read', read_at: readAt } : item
        )
      );
      setUnreadCount(0);
    } catch {
      if (mounted.current) setError('Could not mark all notifications as read.');
    }
  }, []);

  return { notifications, unreadCount, loading, error, refresh, markRead, markAllRead };
}
