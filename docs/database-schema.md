# Database Schema

This document describes the Supabase PostgreSQL schema that backs the AI Virtual
Task Assistant. Supabase is the **automation / reminder / conversation layer**,
not the source of truth for task content — Notion remains the external
workspace. Rows in `assistant_tasks` are therefore a **local mirror** carrying
the Notion identifiers needed to reconcile later (Phases 7+).

All migrations live in [`database/migrations/`](../database/migrations) and are
applied in numeric order:

| Migration                           | Table created                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `0001_user_profiles.sql`            | `public.user_profiles` (also defines `set_updated_at()` and `handle_new_user()`) |
| `0002_assistant_conversations.sql`  | `public.assistant_conversations`                                                 |
| `0003_assistant_messages.sql`       | `public.assistant_messages`                                                      |
| `0004_assistant_tasks.sql`          | `public.assistant_tasks`                                                         |
| `0005_assistant_reminders.sql`      | `public.assistant_reminders`                                                     |
| `0006_notion_connections.sql`       | `public.notion_connections`                                                      |
| `0007_notion_database_mappings.sql` | `public.notion_database_mappings`                                                |
| `0008_assistant_audit_logs.sql`     | `public.assistant_audit_logs`                                                    |
| `0009_assistant_notifications.sql`  | `public.assistant_notifications`                                                 |
| `0010_task_follow_ups.sql`          | `public.assistant_tasks` follow-up columns + index (Phase 15)                    |
| `0011_user_sync_state.sql`          | `public.user_sync_state` (Phase 16 — Notion sync watermark)                      |

## Conventions

- **Primary keys** are `uuid` with `default gen_random_uuid()`.
- **Timestamps** are `timestamptz`; `created_at`/`updated_at` default to
  `now()`. Tables with an `updated_at` column also have a
  `before update ... execute function public.set_updated_at()` trigger
  (defined once in `0001`).
- **Foreign keys** to `auth.users (id)` use `on delete cascade`, so deleting an
  auth user erases all of their data.
- **Row Level Security (RLS)** is enabled on every table. Policies are
  per-user and use `auth.uid() = user_id` for `SELECT`, `INSERT`, `UPDATE`, and
  `DELETE` (the variant table uses `auth.uid() = id`).
- The **server** uses the service-role key via the admin client
  ([`server/src/services/supabase.ts`](../server/src/services/supabase.ts)),
  which **bypasses RLS**. Every repository query therefore also filters by the
  authenticated `user_id` as defense-in-depth; the authenticated user id always
  comes from the verified token, never from the request body.
- Browser clients (the `authenticated` role) only ever see their own rows
  through RLS.

## Relationships

```
auth.users 1───* user_profiles            (1:1 by id)
auth.users 1───* assistant_conversations
auth.users 1───* assistant_messages
auth.users 1───* assistant_tasks
auth.users 1───* assistant_reminders
auth.users 1───1 notion_connections
auth.users 1───* notion_database_mappings
auth.users 1───* assistant_audit_logs
auth.users 1───* assistant_notifications
auth.users 1───1 user_sync_state

assistant_conversations 1───* assistant_messages   (ON DELETE CASCADE)
assistant_tasks         1───* assistant_reminders   (ON DELETE CASCADE)
assistant_tasks         1───* assistant_audit_logs  (ON DELETE SET NULL, soft ref)
assistant_tasks         1───* assistant_notifications (ON DELETE SET NULL, soft ref)
```

---

## `public.user_profiles`

One row per `auth.users` row; created automatically by the `on_auth_user_created`
trigger (`handle_new_user()`).

| Column       | Type          | Notes                                         |
| ------------ | ------------- | --------------------------------------------- |
| `id`         | `uuid`        | PK, FK → `auth.users(id)` `on delete cascade` |
| `email`      | `text`        | Nullable                                      |
| `full_name`  | `text`        | Nullable                                      |
| `timezone`   | `text`        | Not null, default `'UTC'`                     |
| `created_at` | `timestamptz` | Not null, default `now()`                     |
| `updated_at` | `timestamptz` | Not null, default `now()`                     |

**Indexes:** `user_profiles_email_idx (email)`.

**RLS policies:** view/insert/update own row (`auth.uid() = id`).

---

## `public.assistant_conversations`

A single assistant chat thread, owned by one user.

| Column            | Type          | Notes                                               |
| ----------------- | ------------- | --------------------------------------------------- |
| `id`              | `uuid`        | PK, default `gen_random_uuid()`                     |
| `user_id`         | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade` |
| `title`           | `text`        | Nullable, optional human-readable title             |
| `last_message_at` | `timestamptz` | Nullable; set by `appendMessage`, used for ordering |
| `created_at`      | `timestamptz` | Not null, default `now()`                           |
| `updated_at`      | `timestamptz` | Not null, default `now()`                           |

**Indexes:** `assistant_conversations_user_id_idx (user_id)`,
`assistant_conversations_user_last_message_idx (user_id, last_message_at desc)`.

**Triggers:** `assistant_conversations_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.assistant_messages`

An individual message in a conversation. `user_id` is **denormalized** so every
row can be scoped by user alone without joining the parent conversation, and so
RLS policies do not need a join.

| Column            | Type          | Notes                                                            |
| ----------------- | ------------- | ---------------------------------------------------------------- |
| `id`              | `uuid`        | PK, default `gen_random_uuid()`                                  |
| `conversation_id` | `uuid`        | Not null, FK → `assistant_conversations(id)` `on delete cascade` |
| `user_id`         | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`              |
| `role`            | `text`        | Not null, CHECK `role in ('user','assistant')`                   |
| `content`         | `text`        | Not null                                                         |
| `cards`           | `jsonb`       | Nullable; structured UI cards                                    |
| `created_at`      | `timestamptz` | Not null, default `now()`                                        |

**Indexes:** `assistant_messages_conversation_created_idx (conversation_id, created_at)`,
`assistant_messages_user_id_idx (user_id)`.

**Note:** no `updated_at`/trigger — messages are append-only in Phase 6.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.assistant_tasks`

Local mirror of tasks. Supabase holds the automation/reminder copy; Notion holds
the canonical workspace. Notion identity columns stay nullable until a task has
been mirrored (Phase 7+).

| Column               | Type          | Notes                                                                                                                   |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `uuid`        | PK, default `gen_random_uuid()`                                                                                         |
| `user_id`            | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`                                                                     |
| `notion_page_id`     | `text`        | Nullable, external Notion page identity                                                                                 |
| `notion_database_id` | `text`        | Nullable, external Notion database identity                                                                             |
| `notion_url`         | `text`        | Nullable                                                                                                                |
| `title`              | `text`        | Not null                                                                                                                |
| `description`        | `text`        | Nullable                                                                                                                |
| `category`           | `text`        | Nullable                                                                                                                |
| `priority`           | `text`        | Nullable, CHECK `in ('low','medium','high')`                                                                            |
| `status`             | `text`        | Not null, default `'not_started'`; CHECK `in ('not_started','in_progress','blocked','completed','cancelled','overdue')` |
| `due_date`           | `date`        | Nullable                                                                                                                |
| `due_time`           | `time`        | Nullable                                                                                                                |
| `timezone`           | `text`        | Nullable                                                                                                                |
| `source_of_change`   | `text`        | Nullable, CHECK `in ('assistant','notion','system')`                                                                    |
| `sync_status`        | `text`        | Nullable, free-form sync bookkeeping                                                                                    |
| `last_synced_at`     | `timestamptz` | Nullable                                                                                                                |
| `last_follow_up_at`  | `timestamptz` | Nullable; Phase 15 — when a follow-up was last sent (min-interval guard)                                                |
| `follow_up_count`    | `integer`     | Not null, default `0`; Phase 15 — per-task follow-up cap                                                                |
| `blocking_reason`    | `text`        | Nullable; Phase 15 — user-supplied reason a task is blocked                                                             |
| `awaiting_follow_up` | `boolean`     | Not null, default `false`; Phase 15 — true while awaiting the user's answer                                             |
| `created_at`         | `timestamptz` | Not null, default `now()`                                                                                               |
| `updated_at`         | `timestamptz` | Not null, default `now()`                                                                                               |

**Indexes:** `assistant_tasks_user_id_idx (user_id)`,
`assistant_tasks_due_date_idx (due_date)`,
`assistant_tasks_status_idx (status)`,
`assistant_tasks_notion_database_id_idx (notion_database_id)`,
`assistant_tasks_follow_up_idx (user_id, status, due_date)` (Phase 15 — follow-up
candidate scans), unique partial `assistant_tasks_user_notion_page_uidx
(user_id, notion_page_id) where notion_page_id is not null`.

**Follow-up columns (Phase 15).** Added by
[`0010_task_follow_ups.sql`](../database/migrations/0010_task_follow_ups.sql)
with `add column if not exists`; no RLS change (columns are covered by the
existing per-user policies). They back the follow-up engine's anti-spam rules and
the dashboard's _Awaiting Update_ bucket — see
[assistant.md](assistant.md#phase-15--follow-up-engine).

**Triggers:** `assistant_tasks_set_updated_at` → `set_updated_at()`.

**Dashboard query patterns (Phase 12).** The summary/grouped endpoints run a
single `user_id`-scoped `SELECT * FROM assistant_tasks` capped with `LIMIT 100`
(`assistant_tasks_user_id_idx`), ordered by `due_date` then `created_at`. The six
buckets (today/upcoming/overdue/inProgress/awaitingUpdate/completed) are derived
in application code — in the user's timezone — rather than in SQL, so no
additional index is required beyond `(user_id, due_date)`. The filterable list
(`GET /api/tasks`) uses the same `(user_id)` scope plus optional
`status`/`due_date` (between) / `category` predicates, which is why the
`assistant_tasks_status_idx` and `assistant_tasks_due_date_idx` indexes exist.
The list/id responses join `notion_database_mappings` by
`notion_database_id` (using its `(user_id, notion_database_id)` uniqueness) to
surface the human-readable `notion_database_name`; that join is best-effort.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.assistant_reminders`

Reminder schedule records. Created/edited by the reminder API and the
create-task flow, and processed by the Phase 13 reminder worker (scheduling +
in-app delivery). See [reminders.md](reminders.md) for the scheduling modes,
worker lifecycle, and idempotent claiming.

| Column           | Type          | Notes                                                                             |
| ---------------- | ------------- | --------------------------------------------------------------------------------- |
| `id`             | `uuid`        | PK, default `gen_random_uuid()`                                                   |
| `task_id`        | `uuid`        | Not null, FK → `assistant_tasks(id)` `on delete cascade`                          |
| `user_id`        | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`                               |
| `scheduled_for`  | `timestamptz` | Not null                                                                          |
| `timezone`       | `text`        | Nullable                                                                          |
| `channel`        | `text`        | Not null, default `'in_app'`                                                      |
| `status`         | `text`        | Not null, default `'pending'`; CHECK `in ('pending','sent','failed','cancelled')` |
| `recurrence`     | `text`        | Nullable (null = one-shot)                                                        |
| `sent_at`        | `timestamptz` | Nullable                                                                          |
| `failure_reason` | `text`        | Nullable                                                                          |
| `created_at`     | `timestamptz` | Not null, default `now()`                                                         |
| `updated_at`     | `timestamptz` | Not null, default `now()`                                                         |

**Indexes:** `assistant_reminders_status_scheduled_idx (status, scheduled_for)`,
`assistant_reminders_user_id_idx (user_id)`,
`assistant_reminders_task_id_idx (task_id)`.

**Triggers:** `assistant_reminders_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.notion_connections`

Exactly one Notion OAuth connection per user. The access token is encrypted at
the application layer; this column always holds ciphertext, never a raw token,
and the encryption key stays in the server environment.

| Column                   | Type          | Notes                                                           |
| ------------------------ | ------------- | --------------------------------------------------------------- |
| `id`                     | `uuid`        | PK, default `gen_random_uuid()`                                 |
| `user_id`                | `uuid`        | Not null, **UNIQUE**, FK → `auth.users(id)` `on delete cascade` |
| `access_token_encrypted` | `text`        | Not null (ciphertext only)                                      |
| `bot_id`                 | `text`        | Nullable                                                        |
| `workspace_id`           | `text`        | Nullable                                                        |
| `workspace_name`         | `text`        | Nullable                                                        |
| `workspace_icon`         | `text`        | Nullable                                                        |
| `owner`                  | `jsonb`       | Nullable, raw OAuth "owner" payload                             |
| `created_at`             | `timestamptz` | Not null, default `now()`                                       |
| `updated_at`             | `timestamptz` | Not null, default `now()`                                       |

**Indexes:** `user_id` is uniquely indexed by the constraint;
`notion_connections_workspace_id_idx (workspace_id)`.

**Triggers:** `notion_connections_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.notion_database_mappings`

Maps local purposes (`work`/`personal`/`school`/`projects`/`other`) to Notion
databases, with one optional default per user. A Notion database can be mapped
once per user.

| Column               | Type          | Notes                                                                |
| -------------------- | ------------- | -------------------------------------------------------------------- |
| `id`                 | `uuid`        | PK, default `gen_random_uuid()`                                      |
| `user_id`            | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`                  |
| `notion_database_id` | `text`        | Not null                                                             |
| `database_title`     | `text`        | Nullable                                                             |
| `purpose`            | `text`        | Nullable, CHECK `in ('work','personal','school','projects','other')` |
| `is_default`         | `boolean`     | Not null, default `false`                                            |
| `created_at`         | `timestamptz` | Not null, default `now()`                                            |
| `updated_at`         | `timestamptz` | Not null, default `now()`                                            |

**Constraints:** unique `(user_id, notion_database_id)`.

**Indexes:** `notion_database_mappings_user_id_idx (user_id)`.

**Triggers:** `notion_database_mappings_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.assistant_audit_logs`

Append-only audit trail for assistant/tool actions. Immutable in practice; it
intentionally has no `updated_at`. `task_id` is a **soft reference** — if the
mirrored task is deleted the audit row survives with a `NULL` `task_id`, because
history is more valuable than referential strictness here.

| Column           | Type          | Notes                                                     |
| ---------------- | ------------- | --------------------------------------------------------- |
| `id`             | `uuid`        | PK, default `gen_random_uuid()`                           |
| `user_id`        | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`       |
| `action`         | `text`        | Not null                                                  |
| `task_id`        | `uuid`        | Nullable, FK → `assistant_tasks(id)` `on delete set null` |
| `notion_page_id` | `text`        | Nullable                                                  |
| `tool_name`      | `text`        | Nullable                                                  |
| `metadata`       | `jsonb`       | Nullable, arbitrary structured context                    |
| `created_at`     | `timestamptz` | Not null, default `now()`                                 |

**Indexes:** `assistant_audit_logs_user_created_idx (user_id, created_at desc)`,
`assistant_audit_logs_task_id_idx (task_id)`,
`assistant_audit_logs_notion_page_id_idx (notion_page_id)`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.assistant_notifications`

The per-user notification center (Phase 14). One row per recorded notification;
`in_app` delivery writes an `unread` row here _and_ appends a proactive assistant
message. Richer delivery state lives in the reminder rows / audit trail.

| Column       | Type          | Notes                                                        |
| ------------ | ------------- | ------------------------------------------------------------ |
| `id`         | `uuid`        | PK, default `gen_random_uuid()`                              |
| `user_id`    | `uuid`        | Not null, FK → `auth.users(id)` `on delete cascade`          |
| `type`       | `text`        | Not null, e.g. `reminder`/`follow_up`/`task_update`/`system` |
| `title`      | `text`        | Not null                                                     |
| `body`       | `text`        | Nullable                                                     |
| `channel`    | `text`        | Not null, default `'in_app'`                                 |
| `status`     | `text`        | Not null, default `'unread'`; CHECK `in ('unread','read')`   |
| `task_id`    | `uuid`        | Nullable, FK → `assistant_tasks(id)` `on delete set null`    |
| `notion_url` | `text`        | Nullable                                                     |
| `metadata`   | `jsonb`       | Nullable, non-sensitive delivery context only                |
| `created_at` | `timestamptz` | Not null, default `now()`                                    |
| `read_at`    | `timestamptz` | Nullable                                                     |
| `updated_at` | `timestamptz` | Not null, default `now()`                                    |

**Indexes:** `assistant_notifications_user_status_created_idx
(user_id, status, created_at desc)`,
`assistant_notifications_user_created_idx (user_id, created_at desc)`.

**Triggers:** `assistant_notifications_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

---

## `public.user_sync_state`

Per-user Notion synchronization watermark and error bookkeeping (Phase 16). One
row per user (unique on `user_id`). Read/written only by the sync engine and the
`/api/sync` routes; it carries no Notion content, only timing and safe messages.

| Column           | Type          | Notes                                                                                                  |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `id`             | `uuid`        | PK, default `gen_random_uuid()`                                                                        |
| `user_id`        | `uuid`        | Not null, **UNIQUE**, FK → `auth.users(id)` `on delete cascade`                                        |
| `last_synced_at` | `timestamptz` | Nullable — the watermark (last **successful** pull). Drives the `last_edited_time after` query filter. |
| `last_direction` | `text`        | Nullable, CHECK `in ('both','pull','push')`                                                            |
| `last_error`     | `text`        | Nullable — a single, user-safe message for the most recent failure                                     |
| `recent_errors`  | `jsonb`       | Not null, default `'[]'` — bounded list of recent safe messages                                        |
| `created_at`     | `timestamptz` | Not null, default `now()`                                                                              |
| `updated_at`     | `timestamptz` | Not null, default `now()`                                                                              |

**Indexes:** `user_id` is uniquely indexed by the constraint; every read is a
single-row lookup for the authenticated user.

**Triggers:** `user_sync_state_set_updated_at` → `set_updated_at()`.

**RLS policies:** SELECT/INSERT/UPDATE/DELETE scoped by `auth.uid() = user_id`.

**Sync columns on `assistant_tasks` (Phase 16).** The engine also uses the task
mirror's `source_of_change` (`assistant|notion|system`), `sync_status`
(`synced`/`error`/pending), and `last_synced_at` to resolve conflicts, prevent
feedback loops, and report per-status counts. These columns already existed on
`assistant_tasks`; no new columns were required. See
[notion-integration.md](notion-integration.md#10-synchronization-phase-16) for the
pull/push, last-write-wins, watermark, and loop-prevention rules.

---

## Local-mirror rationale

Supabase is deliberately **not** the source of truth for task content:

1. **Notion stays canonical.** Users own their workspace in Notion; the
   assistant needs a local copy to schedule reminders, run queries without
   hitting Notion on every turn, and work in degraded/offline conditions.
2. **Reconciliation needs identity.** `notion_page_id`, `notion_database_id`,
   and `notion_url` let a later sync phase match local rows to Notion pages
   (`source_of_change` records which side drove the last change and
   `sync_status`/`last_synced_at` track reconciliation state).
3. **Reminders/audit are local concerns.** Scheduling, delivery state, and the
   audit trail are assistant concerns that Notion has no place for.

## Applying / security notes

- Apply the migrations to a real Supabase project (SQL editor or Supabase CLI)
  in order. The Phase 6 tests run fully mocked and **do not** create a database,
  so RLS, triggers, CHECK constraints, and cascade behavior are only _exercised_
  once the migrations are applied to a live project.
- The service-role key must never reach the browser. Only the server-side admin
  client (`server/src/services/supabase.ts`) uses it; it is `null` when
  Supabase is unconfigured, and callers degrade gracefully.
