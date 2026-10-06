/**
 * Phase 13 — reminder-side notification abstraction.
 *
 * The reminder engine never knows *how* a notification is delivered; it builds a
 * channel-agnostic {@link NotificationPayload} and hands it to the
 * {@link NotificationService} registered for the reminder's `channel`.
 *
 * Phase 14 extends this additively: it can register additional channels
 * (email/push), an unread notification center, and preferences without changing
 * the engine or the `in_app` implementation. New channels are added with
 * {@link registerNotificationService}; nothing here needs to know about them.
 */

/** A channel-agnostic notification ready for delivery. */
export interface NotificationPayload {
  /** Owner of the notification (always the authenticated reminder's `user_id`). */
  userId: string;
  /** Short headline, e.g. `Reminder: Write report`. */
  title: string;
  /** Body text (task title + deadline). Never contains tokens or raw payloads. */
  body: string;
  /** Logical kind, e.g. `reminder`. */
  type: string;
  /** Related task id, when known. */
  taskId?: string | null;
  /** Related Notion page URL, when known (never a token). */
  notionUrl?: string | null;
  /** Phase 15 — optional interactive cards carried into the message. */
  cards?: unknown[] | null;
  /** Extra, non-sensitive delivery metadata. */
  metadata?: Record<string, unknown> | null;
}

/** A delivery mechanism for one channel. */
export interface NotificationService {
  /** Delivers one notification. Rejecting marks the reminder `failed`. */
  send(notification: NotificationPayload): Promise<void>;
}

/** The channel used when a reminder does not name one. */
export const DEFAULT_NOTIFICATION_CHANNEL = 'in_app';

const registry = new Map<string, NotificationService>();

/** Registers (or replaces) the service for a channel. */
export function registerNotificationService(
  channel: string,
  service: NotificationService
): void {
  registry.set(channel.trim().toLowerCase(), service);
}

/** True when a service is registered for `channel`. */
export function hasNotificationService(channel: string): boolean {
  return registry.has(channel.trim().toLowerCase());
}

/** The channels with a registered service (for diagnostics / Phase 14 UI). */
export function listNotificationChannels(): string[] {
  return [...registry.keys()];
}

/**
 * Returns the service for `channel` (default {@link DEFAULT_NOTIFICATION_CHANNEL}).
 *
 * @throws {Error} when no service is registered for the channel, so the engine
 * records a `failed` reminder rather than silently dropping the notification.
 */
export function getNotificationService(
  channel: string = DEFAULT_NOTIFICATION_CHANNEL
): NotificationService {
  const key = (channel || DEFAULT_NOTIFICATION_CHANNEL).trim().toLowerCase();
  const service = registry.get(key);
  if (!service) {
    throw new Error(`[notifications] No service registered for channel "${key}".`);
  }
  return service;
}
