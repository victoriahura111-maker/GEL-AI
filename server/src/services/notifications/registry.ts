import type {
  AppNotification,
  ChannelDispatchResult,
  DispatchOptions,
  DispatchResult,
  NotificationChannel,
} from './types';

/**
 * Phase 14 — the notification-channel registry + fan-out dispatcher.
 *
 * The registry is a process-wide map from channel name to a
 * {@link NotificationChannel}. `dispatchNotification` fans a single
 * {@link AppNotification} out across the requested channels (default: every
 * registered channel) and **isolates per-channel failures**: one channel
 * throwing never blocks the others, and the outcome is returned per channel.
 */

const channels = new Map<string, NotificationChannel>();

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Registers (or replaces) a channel. */
export function registerChannel(channel: NotificationChannel): void {
  channels.set(normalize(channel.name), channel);
}

/** The channel registered for `name`, or `undefined` when unknown. */
export function getChannel(name: string): NotificationChannel | undefined {
  return channels.get(normalize(name));
}

/** Every registered channel, in registration order. */
export function listChannels(): NotificationChannel[] {
  return [...channels.values()];
}

/** Registered channel names, in registration order. */
export function listChannelNames(): string[] {
  return [...channels.keys()];
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Delivers `notification` through the requested channels.
 *
 * - Default: every registered channel (disabled ones are reported `skipped`).
 * - A channel that throws yields a `failed` result for that channel only.
 * - A requested-but-unregistered name yields an `unknown` result.
 *
 * Never rejects: failures are described in {@link DispatchResult.results}.
 */
export async function dispatchNotification(
  notification: AppNotification,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const requested =
    options.channels && options.channels.length > 0
      ? options.channels.map(normalize)
      : [...channels.keys()];

  const results: ChannelDispatchResult[] = [];

  for (const name of requested) {
    const channel = channels.get(name);

    if (!channel) {
      results.push({
        channel: name,
        status: 'unknown',
        error: `No channel registered for "${name}".`,
      });
      continue;
    }

    if (!channel.isEnabled()) {
      results.push({ channel: channel.name, status: 'skipped' });
      continue;
    }

    try {
      await channel.send(notification);
      results.push({ channel: channel.name, status: 'sent' });
    } catch (error) {
      results.push({
        channel: channel.name,
        status: 'failed',
        error: messageOf(error, 'Notification delivery failed.'),
      });
    }
  }

  return {
    results,
    delivered: results.filter((result) => result.status === 'sent').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    unknown: results.filter((result) => result.status === 'unknown').length,
  };
}
