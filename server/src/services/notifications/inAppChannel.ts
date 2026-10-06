import {
  appendMessage,
  getOrCreateConversation,
  listConversations,
} from '../conversations';
import { createNotification } from './repository';
import type { AppNotification, NotificationChannel } from './types';
import type { NotificationPayload, NotificationService } from './notificationService';

/**
 * Phase 13/14 — the real `in_app` delivery channel.
 *
 * In-app delivery has **two complementary effects**:
 *  1. it persists an `unread` row in `assistant_notifications` (the durable
 *     notification-center record the bell polls), and
 *  2. it appends a proactive **assistant message** to the user's most recent
 *     conversation (creating one when the user has none), so the reminder /
 *     follow-up shows up inside the assistant UI exactly like any other turn.
 *
 * ## Failure isolation
 *
 * The two effects are attempted independently. A failure in one is logged and
 * does not prevent the other; `send` rejects only when **both** fail (so the
 * reminder engine records a genuine failed delivery rather than a partial one).
 *
 * ## Degradation
 *
 * When Supabase is unconfigured the repositories return `null`/`[]` without
 * throwing, so `send` resolves as a no-op instead of failing the reminder.
 */

export const IN_APP_CHANNEL_NAME = 'in_app';

/** Builds the assistant-facing message body for a notification. */
function renderBody(notification: AppNotification): string {
  const lines = [notification.title, notification.body].filter(
    (part) => typeof part === 'string' && part.trim().length > 0
  );
  return lines.join('\n\n');
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const inAppChannel: NotificationChannel = {
  name: 'in_app',
  isEnabled: () => true,
  async send(notification: AppNotification): Promise<void> {
    const failures: string[] = [];

    // (1) Durable unread row for the notification center.
    let persisted = false;
    try {
      await createNotification(notification.userId, {
        type: notification.type,
        title: notification.title,
        body: notification.body,
        channel: IN_APP_CHANNEL_NAME,
        taskId: notification.taskId ?? null,
        notionUrl: notification.notionUrl ?? null,
        metadata: notification.metadata ?? null,
      });
      persisted = true;
    } catch (error) {
      failures.push(messageOf(error, 'Could not persist the in-app notification.'));
    }

    // (2) Proactive assistant message in the chat.
    let appended = false;
    try {
      const [latest] = await listConversations(notification.userId);
      const conversation = latest ?? (await getOrCreateConversation(notification.userId));

      if (conversation) {
        await appendMessage(notification.userId, conversation.id, {
          role: 'assistant',
          content: renderBody(notification),
          // Phase 15 — carry interactive cards (e.g. a follow-up card) into the
          // proactive message so the user can act inline. Notifications without
          // cards keep the Phase 13/14 behavior (`null`).
          cards: notification.cards ?? null,
        });
      }
      appended = true;
    } catch (error) {
      failures.push(messageOf(error, 'Could not append the in-app assistant message.'));
    }

    if (!persisted && !appended) {
      throw new Error(`[notifications] in_app delivery failed: ${failures.join('; ')}`);
    }
  },
};

/**
 * Phase 13 compatibility adapter.
 *
 * The reminder engine (and any existing caller) depends on
 * `getNotificationService('in_app').send(payload)`. This adapter preserves that
 * contract while routing through the channel above, so the engine gains the
 * notification-center row for free without any change at its call site.
 */
export const inAppNotificationService: NotificationService = {
  async send(notification: NotificationPayload): Promise<void> {
    await inAppChannel.send(notification);
  },
};
