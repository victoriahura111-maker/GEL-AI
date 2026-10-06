# Reminders

Phase 13 turns the `assistant_reminders` rows written in earlier phases into a
working, scheduled notification pipeline: schedule computation, a background
worker with idempotent claiming, recurrence, an in-app delivery channel, and a
management API + UI.

Scheduling and delivery require Supabase to be configured
(`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). With Supabase unset the worker
never starts and `/api/reminders` responds `503`.

## Scheduling modes

`computeScheduledFor` (in `server/src/services/reminders/schedule.ts`) is pure
and turns a reminder intent into an absolute UTC instant. It has two modes:

### `at` — absolute / wall-clock time

- A value with an explicit offset (`2026-10-06T16:00:00Z`, `...+01:00`) is
  absolute and honoured verbatim.
- A _naive_ value (`2026-10-06T16:00`, `2026-10-06 16:00`, or a date-only
  `2026-10-06` → `00:00`) is interpreted as **wall-clock time in the user's
  timezone** and converted to UTC.
- A computed instant in the past is rejected with `datetime_in_past` (HTTP
  `400`) — except in the `create_task` flow, which passes `allowPast: true` so a
  model-supplied time that has just passed is still recorded and fired on the
  next worker tick.

### `before` — relative to the task deadline

- Subtracts a parsed offset from the task deadline.
- **Deadline rule:** when the task has no `due_time`, the deadline is the **end
  of the due day at `23:59` in the user's timezone**. This is deliberate: a
  date-only deadline means "sometime that day", so subtracting from the end of
  the day is the least surprising interpretation.
- A missing deadline raises `missing_deadline` (HTTP `400`).

### Offset grammar

`<integer> <unit>` with an optional space; units are case-insensitive.

| Accepted units                     | Examples                |
| ---------------------------------- | ----------------------- |
| `minute`, `minutes`, `min`, `mins` | `30 minutes`, `15 mins` |
| `hour`, `hours`, `hr`, `hrs`       | `2 hours`, `1 hr`       |
| `day`, `days`                      | `1 day`, `3 days`       |
| `week`, `weeks`                    | `1 week`, `2 weeks`     |

Anything else (missing value, non-integer amount, unknown unit) raises
`invalid_offset` (HTTP `400`).

### Timezone handling

`Intl.DateTimeFormat` converts a wall-clock value to UTC with a two-pass offset
correction (correct across DST boundaries). An empty or invalid IANA timezone
silently falls back to `UTC` — a bad profile value never throws. No date library
is used.

## API

All routes are authenticated and `user_id`-scoped; a foreign or missing reminder
is a `404`.

| Method + path                        | Purpose                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/reminders`                 | List the caller's reminders (default window: 7 days back → 30 days ahead). Query: `status`, `from`, `to`, `limit`.                                     |
| `POST /api/reminders`                | Create a reminder for one of the caller's tasks. Body: `taskId` plus one of `scheduledFor` / `datetime` / `before`, optional `timezone`, `recurrence`. |
| `POST /api/reminders/:id/cancel`     | Cancel an owned reminder.                                                                                                                              |
| `POST /api/reminders/:id/reschedule` | Re-arm an owned reminder. Body: one of `scheduledFor` / `datetime` / `before`, optional `timezone`.                                                    |

Reminder responses embed a compact `task` reference (`id`, `title`, `due_date`,
`due_time`, `status`, `notion_url`). Notion tokens and raw Notion payloads are
never returned.

## Worker lifecycle

`server/src/index.ts` calls `startReminderScheduler()` on boot and
`stopReminderScheduler()` on `SIGTERM`/`SIGINT`.

- The loop is a `setInterval` (`REMINDER_TICK_MS`, default `60000`).
- **Overlap protection:** if a tick is still in flight, the next interval is
  skipped.
- **Hard cap:** each tick considers at most 50 due reminders.
- The interval is `unref()`d so it never keeps the event loop alive on its own.
- The scheduler starts only when Supabase is configured **and**
  `REMINDERS_ENABLED` is not `false`. It is **never** started by tests; only the
  server bootstrap calls `startReminderScheduler`.

`processDueReminders(now?, limit?)` is the testable core, decoupled from the
loop.

## Idempotency / claiming

For each due reminder the worker performs an atomic claim:
`UPDATE ... SET status='sent' WHERE id = ? AND status = 'pending'`. Only the
first caller matches a row; a concurrent or replayed tick matches nothing and
the reminder is counted as `skipped`, so a notification is never delivered
twice. `markReminderSent` then fills `sent_at`; if dispatch fails the claim is
reversed with `markReminderFailed`.

## Failure handling

A tick never throws and never aborts on one bad item:

| Situation                      | Outcome                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| Task missing / deleted         | reminder marked `failed` (`The related task was not found.`) |
| Task `completed` / `cancelled` | reminder marked `failed`; recurrence stops                   |
| Notification rejected          | reminder marked `failed` with the error message              |
| List query or claim error      | logged; tick returns/continues                               |

Successful deliveries write a `reminder_sent` audit row; failures write
`reminder_failed` (best-effort — an audit failure never fails the tick).

## Recurrence

A reminder with `recurrence` (`daily` or `weekly`) arms the **next** occurrence
after a successful send by creating a fresh `pending` row at
`scheduled_for + recurrence`, preserving history. Advancement skips forward
until the instant is in the future, so a backlog after downtime does not replay.
Recurrence is a fixed duration (24h / 7d) applied to the stored instant and is
DST-agnostic. There is no recurrence when the related task is missing, completed,
or cancelled.

## Delivery: the `in_app` channel

`getNotificationService(channel)` returns the `NotificationService` registered
for the reminder's channel (default `in_app`). The engine builds a
channel-agnostic payload (`title`, `body` with the task title + deadline,
`taskId`, `notionUrl`, `metadata`) and calls `send`.

The `in_app` implementation appends a proactive **assistant message** to the
user's most recent conversation (creating one when none exists), so fired
reminders appear inside the assistant UI. It is a genuine delivery mechanism,
not a placeholder. See [`notifications.md`](notifications.md) for how Phase 14
extends the abstraction.

## Environment variables

| Variable            | Default | Meaning                            |
| ------------------- | ------- | ---------------------------------- |
| `REMINDER_TICK_MS`  | `60000` | Worker interval in milliseconds.   |
| `REMINDERS_ENABLED` | `true`  | Set `false` to disable the worker. |

Both are optional. Reminders additionally require Supabase to be configured.
