import type { NotificationChannel, NotificationChannelName } from './types';

/**
 * Phase 14 — factory for a **disabled** placeholder channel.
 *
 * The email/push/SMS/WhatsApp/Telegram channels are intentionally not
 * implemented yet. Registering a disabled placeholder (instead of nothing)
 * keeps the registry *total*: `listChannels()` can enumerate the roadmap, and
 * `dispatchNotification` reports them as `skipped` rather than `unknown`.
 *
 * To implement a real channel: create a module exporting a
 * `NotificationChannel` with `isEnabled() => true`, replace the placeholder in
 * `index.ts`, and document the credentials it needs. See `docs/notifications.md`.
 */
export function createDisabledChannel(name: NotificationChannelName): NotificationChannel {
  return {
    name,
    isEnabled: () => false,
    async send(): Promise<void> {
      // Defensive: `dispatchNotification` skips disabled channels, so this is
      // only reachable if a caller invokes the channel directly.
      throw new Error(`[notifications] The "${name}" channel is not implemented yet.`);
    },
  };
}
