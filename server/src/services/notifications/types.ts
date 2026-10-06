/**
 * Phase 14 — the formal notification-channel abstraction.
 *
 * Phase 13 shipped a reminder-first `NotificationService { send }`. Phase 14
 * generalises that into a named {@link NotificationChannel} (with an explicit
 * {@link NotificationChannel.isEnabled} flag) plus a registry that can fan a
 * single notification out across several channels and isolate failures.
 *
 * Only `in_app` is implemented. `email`/`push`/`sms`/`whatsapp`/`telegram` are
 * registered as **disabled** placeholders — see `disabledChannel.ts` and
 * `docs/notifications.md` for exactly how to add a real one.
 */

/** Every channel the platform knows about (implemented or not). */
export type NotificationChannelName =
  | 'in_app'
  | 'email'
  | 'push'
  | 'sms'
  | 'whatsapp'
  | 'telegram';

/** All channel names, including the not-yet-implemented ones. */
export const NOTIFICATION_CHANNELS: NotificationChannelName[] = [
  'in_app',
  'email',
  'push',
  'sms',
  'whatsapp',
  'telegram',
];

/**
 * A channel-agnostic notification handed to each channel's `send`.
 *
 * `taskId`/`notionUrl` are optional soft references; `metadata` carries
 * non-sensitive delivery context only (never tokens or raw Notion payloads).
 */
export interface AppNotification {
  /** Owner of the notification (always the authenticated user's id). */
  userId: string;
  /** Logical kind, e.g. `reminder` | `follow_up` | `task_update` | `system`. */
  type: string;
  /** Short headline, e.g. `Reminder: Write report`. */
  title: string;
  /** Body text (task title + deadline). Never contains tokens or raw payloads. */
  body: string;
  /** Related task id, when known. */
  taskId?: string | null;
  /** Related Notion page URL, when known (never a token). */
  notionUrl?: string | null;
  /**
   * Phase 15 — optional interactive cards carried into the proactive assistant
   * message (e.g. a `follow_up` card with buttons). The in-app channel appends
   * them to the message so the user can respond inline.
   */
  cards?: unknown[] | null;
  /** Extra, non-sensitive delivery metadata. */
  metadata?: Record<string, unknown> | null;
}

/** A delivery mechanism for one channel. */
export interface NotificationChannel {
  /** Stable channel identifier. */
  name: NotificationChannelName;
  /**
   * Whether the channel can currently deliver. Disabled channels are skipped by
   * {@link dispatchNotification} (they are registered so the registry is total
   * and the UI/roadmap can enumerate them).
   */
  isEnabled(): boolean;
  /** Delivers one notification. Rejecting marks the attempt failed. */
  send(notification: AppNotification): Promise<void>;
}

/** Outcome of one channel attempt. */
export type ChannelDispatchStatus = 'sent' | 'skipped' | 'failed' | 'unknown';

/** Per-channel result within a {@link DispatchResult}. */
export interface ChannelDispatchResult {
  /** The channel the attempt targeted (may be an unregistered name). */
  channel: string;
  status: ChannelDispatchStatus;
  /** Human-readable reason when `status` is `failed` or `unknown`. */
  error?: string;
}

/** Options for {@link dispatchNotification}. */
export interface DispatchOptions {
  /**
   * Channels to target. Defaults to **every registered channel**; disabled
   * channels are reported as `skipped` rather than sent. Pass an explicit list
   * (including unknown names) to see `unknown` results.
   */
  channels?: string[];
}

/** Aggregate outcome of a dispatch. */
export interface DispatchResult {
  /** One entry per attempted channel, in request order. */
  results: ChannelDispatchResult[];
  /** Channels that resolved successfully. */
  delivered: number;
  /** Channels that threw while sending. */
  failed: number;
  /** Registered-but-disabled channels that were skipped. */
  skipped: number;
  /** Requested channels that are not registered at all. */
  unknown: number;
}
