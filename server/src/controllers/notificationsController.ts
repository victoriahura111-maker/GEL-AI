import type { Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
} from '../services/notifications/repository';
import type { NotificationRecord } from '../services/notifications/repository';
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
} from '../validators/notification';

/**
 * Phase 14 — `/api/notifications` controllers.
 *
 * Thin handlers over `services/notifications/repository`: they translate HTTP
 * inputs into repository calls and map outcomes to status codes. Every query is
 * scoped to `req.user.id`; a foreign notification is indistinguishable from a
 * missing one (both `404`). `metadata` is intentionally **not** returned, so no
 * raw delivery payload can leak to the browser.
 */

/** Browser-safe projection of a notification row. */
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  status: NotificationRecord['status'];
  task_id: string | null;
  notion_url: string | null;
  created_at: string;
  read_at: string | null;
  updated_at: string;
}

function isUnconfigured(): boolean {
  return !supabaseAdmin;
}

/** Drops server-only fields (`user_id`, `metadata`). */
export function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    channel: record.channel,
    status: record.status,
    task_id: record.task_id,
    notion_url: record.notion_url,
    created_at: record.created_at,
    read_at: record.read_at,
    updated_at: record.updated_at,
  };
}

/** `GET /api/notifications` — list the caller's notifications (newest first). */
export async function getNotifications(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Notification storage is not configured' });
    return;
  }

  const parsed = notificationListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }

  try {
    const { notifications, nextCursor } = await listNotifications(userId, {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    });

    res.json({ notifications: notifications.map(toNotificationView), nextCursor });
  } catch {
    console.error('[notifications] Could not list notifications.');
    res.status(500).json({ error: 'Could not load notifications' });
  }
}

/** `GET /api/notifications/unread-count` — the bell badge count. */
export async function getUnreadCount(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Notification storage is not configured' });
    return;
  }

  try {
    res.json({ count: await countUnread(userId) });
  } catch {
    console.error('[notifications] Could not count unread notifications.');
    res.status(500).json({ error: 'Could not load the unread count' });
  }
}

/**
 * `POST /api/notifications/:id/read` — mark one owned notification read.
 * `404` when it does not exist / is not owned.
 */
export async function postMarkRead(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Notification storage is not configured' });
    return;
  }

  const id = notificationIdParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }

  try {
    const updated = await markRead(userId, id.data);
    if (!updated) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    res.json({ notification: toNotificationView(updated) });
  } catch {
    console.error('[notifications] Could not mark the notification as read.');
    res.status(500).json({ error: 'Could not update the notification' });
  }
}

/** `POST /api/notifications/read-all` — mark every unread notification read. */
export async function postMarkAllRead(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (isUnconfigured()) {
    res.status(503).json({ error: 'Notification storage is not configured' });
    return;
  }

  try {
    res.json({ updated: await markAllRead(userId) });
  } catch {
    console.error('[notifications] Could not mark all notifications as read.');
    res.status(500).json({ error: 'Could not update the notifications' });
  }
}
