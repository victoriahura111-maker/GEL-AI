import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import type { AppNotification } from '../../services/notifications';
import { cn } from '../../utils/cn';

/**
 * Phase 14 — the notification bell + dropdown panel.
 *
 * Renders in the `TopBar` on every breakpoint. The badge mirrors the unread
 * count; opening the panel lists the most recent notifications (grouped by
 * type with a relative timestamp). Selecting one marks it read and navigates to
 * the most relevant screen.
 */

const TYPE_LABELS: Record<string, string> = {
  reminder: 'Reminder',
  follow_up: 'Follow-up',
  task_update: 'Task update',
  system: 'System',
};

/** Human, dependency-free relative time ("just now", "5m ago", "3d ago"). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const diff = now - then;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return 'just now';
  if (abs < hour) return `${Math.round(abs / minute)}m ago`;
  if (abs < day) return `${Math.round(abs / hour)}h ago`;
  if (abs < 7 * day) return `${Math.round(abs / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Where a notification should take the user when opened. */
export function notificationTarget(notification: AppNotification): string {
  if (notification.type === 'reminder') return '/reminders';
  if (notification.task_id) return '/tasks';
  return '/dashboard';
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Escape closes the panel; focus moves into it when it opens.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const handleSelect = useCallback(
    async (notification: AppNotification) => {
      if (notification.status === 'unread') {
        await markRead(notification.id);
      }
      setOpen(false);
      navigate(notificationTarget(notification));
    },
    [markRead, navigate]
  );

  const handleMarkAllRead = useCallback(() => {
    void markAllRead();
  }, [markAllRead]);

  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold text-white"
          >
            {badgeLabel}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" aria-hidden="true" onClick={close} />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            tabIndex={-1}
            className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-card focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-900">Notifications</h2>
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={unreadCount === 0}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-transparent"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Mark all read
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {loading ? (
                <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading…
                </p>
              ) : notifications.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-500">
                  You are all caught up.
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {notifications.map((notification) => (
                    <li key={notification.id}>
                      <button
                        type="button"
                        onClick={() => void handleSelect(notification)}
                        className={cn(
                          'flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-gray-50',
                          notification.status === 'unread' && 'bg-brand-50/40'
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                            {TYPE_LABELS[notification.type] ?? 'Notification'}
                          </span>
                          <span className="shrink-0 text-xs text-gray-400">
                            {relativeTime(notification.created_at)}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
                          {notification.status === 'unread' ? (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-brand-600"
                              aria-hidden="true"
                            />
                          ) : null}
                          {notification.title}
                        </span>
                        {notification.body ? (
                          <span className="text-xs text-gray-500">{notification.body}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
