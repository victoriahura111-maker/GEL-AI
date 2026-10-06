# Notifications

The notification system delivers time-based and assistant-driven alerts to the
user. It has two layers:

1. a **channel abstraction** (how an event is delivered), and
2. a **notification center** (a per-user, unread/read inbox surfaced by the bell).

The reminder engine (`services/reminders/engine.ts`) only knows about the
abstraction, so it is independent of how a notification is delivered.

## The model

A channel-agnostic notification is an `AppNotification`
([`server/src/services/notifications/types.ts`](../server/src/services/notifications/types.ts)):

```ts
interface AppNotification {
  userId: string; // always the authenticated user's id
  type: string; // 'reminder' | 'follow_up' | 'task_update' | 'system'
  title: string;
  body: string;
  taskId?: string | null; // soft reference to assistant_tasks
  notionUrl?: string | null; // never a token
  cards?: unknown[] | null; // Phase 15 — interactive cards (e.g. a follow_up card)
  metadata?: Record<string, unknown> | null; // non-sensitive delivery context only
}
```

`cards` is optional and backward-compatible: a notification without cards keeps
the Phase 13/14 behavior (the in-app assistant message carries `cards: null`).
The Phase 15 follow-up engine sets it to a single `follow_up` card so the
proactive message renders actionable buttons; see
[assistant.md](assistant.md#phase-15--follow-up-engine).

## The channel abstraction

```ts
interface NotificationChannel {
  name: NotificationChannelName; // 'in_app' | 'email' | 'push' | 'sms' | 'whatsapp' | 'telegram'
  isEnabled(): boolean; // disabled channels are skipped by dispatch
  send(n: AppNotification): Promise<void>;
}
```

### Registry + dispatcher

[`registry.ts`](../server/src/services/notifications/registry.ts) keeps a
process-wide map of channels:

| Function                                 | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `registerChannel(channel)`               | Register (or replace) a channel.              |
| `getChannel(name)`                       | Look one up; `undefined` when unknown.        |
| `listChannels()` / `listChannelNames()`  | Enumerate the registry (roadmap/diagnostics). |
| `dispatchNotification(n, { channels? })` | Fan a notification out across channels.       |

`dispatchNotification` **isolates per-channel failures** — one channel throwing
never blocks the others — and returns a per-channel result:

```ts
interface DispatchResult {
  results: { channel: string; status: 'sent' | 'skipped' | 'failed' | 'unknown'; error?: string }[];
  delivered: number;
  failed: number;
  skipped: number;
  unknown: number;
}
```

- Default target set is **every registered channel**; disabled ones are reported
  as `skipped` (never sent).
- An explicitly requested, unregistered name yields `unknown`.
- A channel whose `send` rejects yields `failed` for that channel only.

### Backward compatibility (Phase 13)

Phase 13 ships a simpler `NotificationService { send }` registry keyed by
channel name, which the reminder engine dispatches through
(`getNotificationService(channel).send(payload)`). Phase 14 keeps it intact:

- [`inAppChannel.ts`](../server/src/services/notifications/inAppChannel.ts)
  exports the real `inAppChannel` **and** a thin `inAppNotificationService`
  adapter.
- [`index.ts`](../server/src/services/notifications/index.ts) registers `in_app`
  in **both** registries, so the reminder engine's call site is unchanged while
  still gaining the notification-center row.

### Implemented vs. roadmap channels

Only **`in_app`** is implemented. `email`, `push`, `sms`, `whatsapp`, and
`telegram` are registered as **disabled placeholders** via
`createDisabledChannel(name)` (see
[`disabledChannel.ts`](../server/src/services/notifications/disabledChannel.ts)),
so the registry is _total_: `dispatchNotification` reports them as `skipped`
rather than `unknown`, and the UI/roadmap can enumerate them.

## How to add a channel

1. Create `server/src/services/notifications/<name>Channel.ts` exporting a
   `NotificationChannel`:

   ```ts
   export const emailChannel: NotificationChannel = {
     name: 'email',
     isEnabled: () => config.emailEnabled, // e.g. an env flag
     async send(notification) {
       // call your provider; throw on failure so the attempt is reported 'failed'
     },
   };
   ```

2. In [`index.ts`](../server/src/services/notifications/index.ts), replace the
   disabled placeholder for that name:

   ```ts
   registerChannel(emailChannel); // instead of createDisabledChannel('email')
   ```

3. Add the provider credentials to `server/src/config` and `.env.example`, and
   document them here. Nothing else changes — the reminder engine and the routes
   already speak `AppNotification`/`dispatchNotification`.

> Do **not** send secrets, tokens, or raw Notion payloads through
> `AppNotification.metadata` or the provider.

## The notification table + RLS

`public.assistant_notifications` (migration
[`0009_assistant_notifications.sql`](../database/migrations/0009_assistant_notifications.sql)):

| Column       | Type          | Notes                                                      |
| ------------ | ------------- | ---------------------------------------------------------- |
| `id`         | `uuid`        | PK, default `gen_random_uuid()`                            |
| `user_id`    | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`        |
| `type`       | `text`        | Not null (`reminder`/`follow_up`/`task_update`/`system`)   |
| `title`      | `text`        | Not null                                                   |
| `body`       | `text`        | Nullable                                                   |
| `channel`    | `text`        | Not null, default `'in_app'`                               |
| `status`     | `text`        | Not null, default `'unread'`; CHECK `in ('unread','read')` |
| `task_id`    | `uuid`        | Nullable, FK → `assistant_tasks(id)` `on delete set null`  |
| `notion_url` | `text`        | Nullable                                                   |
| `metadata`   | `jsonb`       | Nullable, non-sensitive only                               |
| `created_at` | `timestamptz` | Not null, default `now()`                                  |
| `read_at`    | `timestamptz` | Nullable                                                   |
| `updated_at` | `timestamptz` | Not null, default `now()`; `set_updated_at()` trigger      |

Indexes: `(user_id, status, created_at desc)` (badge) and
`(user_id, created_at desc)` (list). RLS is enabled with per-user
`auth.uid() = user_id` policies for SELECT/INSERT/UPDATE/DELETE.

The repository
([`repository.ts`](../server/src/services/notifications/repository.ts)) is
**always** `user_id`-scoped and degrades gracefully when Supabase is
unconfigured:

| Function                                                         | Behaviour                                   |
| ---------------------------------------------------------------- | ------------------------------------------- |
| `createNotification(userId, payload)`                            | Inserts an `unread` row.                    |
| `listNotifications(userId, { status?, type?, limit?, cursor? })` | Newest-first page + opaque `nextCursor`.    |
| `countUnread(userId)`                                            | Badge count.                                |
| `markRead(userId, id)`                                           | Marks one owned row `read` (or `null`).     |
| `markAllRead(userId)`                                            | Marks all unread `read`; returns the count. |

## In-app delivery semantics

`in_app` has **two complementary effects** and attempts both independently:

1. **Persist** an `unread` `assistant_notifications` row (the durable record
   the bell polls), **and**
2. **Append** a proactive assistant message to the user's most recent
   conversation (creating one if none), so the reminder/follow-up appears in the
   chat exactly like any other assistant turn. The message carries the
   notification's `cards` (Phase 15) so a follow-up renders with its buttons.

A failure in one does not prevent the other; `send` rejects **only when both
fail** (so the reminder engine records a genuine failure, not a partial one).
When Supabase is unconfigured the repositories are no-ops, so `send` resolves.

## Endpoints

All routes are token-protected and caller-scoped; `503` when Supabase is
unconfigured, `400` for invalid parameters.

| Method + path                         | Body / query                                   | Response                                                            |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/notifications`              | `status?`, `type?`, `limit?` (≤100), `cursor?` | `{ notifications: NotificationView[], nextCursor: string \| null }` |
| `GET /api/notifications/unread-count` | —                                              | `{ count: number }`                                                 |
| `POST /api/notifications/:id/read`    | —                                              | `{ notification: NotificationView }` (404 if not owned)             |
| `POST /api/notifications/read-all`    | —                                              | `{ updated: number }`                                               |

`NotificationView` deliberately omits `user_id` and `metadata`, so no raw
delivery payload or token can reach the browser.

## Polling strategy

The client hook
([`useNotifications.ts`](../client/src/hooks/useNotifications.ts)) fetches the
list and unread count on mount and then **polls every 30s** (configurable via
`pollIntervalMs`), clearing the interval on unmount. `enabled: false` pauses all
fetching (e.g. signed out). It exposes `notifications`, `unreadCount`,
`loading`, `error`, `refresh`, `markRead`, and `markAllRead`; read mutations are
applied optimistically to the local list.

The bell
([`NotificationBell.tsx`](../client/src/components/notifications/NotificationBell.tsx))
renders in `TopBar` on every breakpoint with an unread badge and an accessible
panel (`aria-haspopup`/`aria-expanded`/`role="dialog"`, Escape + backdrop close,
focus management). Selecting an item marks it read and routes to `/reminders`
(reminders), `/tasks` (task-linked), or `/dashboard`.

## Future-channel roadmap

| Channel    | Integration point                         | Notes                                               |
| ---------- | ----------------------------------------- | --------------------------------------------------- |
| `email`    | new `emailChannel.ts` + `registerChannel` | Provider (e.g. Resend/SES) credentials in `config`. |
| `push`     | new `pushChannel.ts`                      | Web-push subscription store + VAPID keys.           |
| `sms`      | new `smsChannel.ts`                       | Provider (e.g. Twilio) credentials.                 |
| `whatsapp` | new `whatsappChannel.ts`                  | Business API credentials.                           |
| `telegram` | new `telegramChannel.ts`                  | Bot token + chat-id linking.                        |

Each only needs a `NotificationChannel` implementation and a
`registerChannel(...)` call replacing its disabled placeholder; the table,
endpoints, hook, and bell already handle the in-app side.

See [`reminders.md`](reminders.md) for the worker lifecycle and
[`database-schema.md`](database-schema.md) for the schema.
