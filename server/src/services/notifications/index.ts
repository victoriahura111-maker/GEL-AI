import { createDisabledChannel } from './disabledChannel';
import { inAppChannel, inAppNotificationService } from './inAppChannel';
import {
  DEFAULT_NOTIFICATION_CHANNEL,
  registerNotificationService,
} from './notificationService';
import { registerChannel } from './registry';
import { NOTIFICATION_CHANNELS } from './types';

/**
 * Phase 13/14 — notifications barrel.
 *
 * Importing this module wires the built-in channels into **both** registries:
 *  - the Phase 13 `NotificationService` registry (keyed by channel name) that
 *    the reminder engine dispatches through, and
 *  - the Phase 14 formal `NotificationChannel` registry used by
 *    `dispatchNotification` (the extension point for email/push/etc.).
 *
 * Additive by design: adding a channel means registering it here.
 */

// Phase 13 — reminder-engine service registry (backward compatible).
registerNotificationService(DEFAULT_NOTIFICATION_CHANNEL, inAppNotificationService);

// Phase 14 — formal channel registry. `in_app` is real; every other channel is
// a disabled placeholder so the registry enumerates the roadmap and dispatch
// reports them as `skipped` rather than `unknown`.
registerChannel(inAppChannel);
for (const name of NOTIFICATION_CHANNELS) {
  if (name === 'in_app') continue;
  registerChannel(createDisabledChannel(name));
}

// Phase 13 service registry API.
export {
  getNotificationService,
  registerNotificationService,
  hasNotificationService,
  listNotificationChannels,
  DEFAULT_NOTIFICATION_CHANNEL,
} from './notificationService';
export type { NotificationPayload, NotificationService } from './notificationService';

// Phase 14 channel registry + dispatch.
export {
  registerChannel,
  getChannel,
  listChannels,
  listChannelNames,
  dispatchNotification,
} from './registry';

// Channels.
export { inAppChannel, inAppNotificationService, IN_APP_CHANNEL_NAME } from './inAppChannel';
export { createDisabledChannel } from './disabledChannel';

// Repository.
export {
  createNotification,
  listNotifications,
  countUnread,
  markRead,
  markAllRead,
  NotificationRepositoryError,
} from './repository';
export type {
  NotificationRecord,
  NotificationStatus,
  CreateNotificationInput,
  ListNotificationsFilters,
  ListNotificationsResult,
} from './repository';

// Types.
export { NOTIFICATION_CHANNELS } from './types';
export type {
  AppNotification,
  NotificationChannel,
  NotificationChannelName,
  ChannelDispatchResult,
  ChannelDispatchStatus,
  DispatchOptions,
  DispatchResult,
} from './types';
