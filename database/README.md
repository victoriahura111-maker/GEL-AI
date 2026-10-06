# Database (Supabase / PostgreSQL)

This directory holds the SQL migrations that define the `public` schema for the
AI Virtual Task Assistant. Supabase is the **automation and reminder layer**;
Notion remains the external workspace of record for task content (the local
`assistant_tasks` table is a mirror — see [`docs/database-schema.md`](../docs/database-schema.md)).

## Migrations

| File | Creates |
| --- | --- |
| `0001_user_profiles.sql` | `user_profiles`, `set_updated_at()`, `handle_new_user()` trigger |
| `0002_assistant_conversations.sql` | `assistant_conversations` |
| `0003_assistant_messages.sql` | `assistant_messages` |
| `0004_assistant_tasks.sql` | `assistant_tasks` (local Notion mirror) |
| `0005_assistant_reminders.sql` | `assistant_reminders` |
| `0006_notion_connections.sql` | `notion_connections` |
| `0007_notion_database_mappings.sql` | `notion_database_mappings` |
| `0008_assistant_audit_logs.sql` | `assistant_audit_logs` |
| `0009_assistant_notifications.sql` | `assistant_notifications` (notification center) |
| `0010_task_follow_ups.sql` | `assistant_tasks` follow-up columns + index (Phase 15) |

Migrations are **ordered** and must be applied in filename order.
`0001_user_profiles.sql` defines `public.set_updated_at()`, which every later
migration reuses for its `updated_at` trigger.

## Applying migrations

### Option A — Supabase CLI (recommended)

```sh
# Authenticate and link this repo to your project (once).
supabase login
supabase link --project-ref <your-project-ref>

# Apply all pending migrations to the linked remote project.
supabase db push

# Or, within a local dev stack started with `supabase start`:
supabase migration up
```

To create a brand-new migration in the future:

```sh
supabase migration new <name>
```

### Option B — SQL editor

Open the Supabase dashboard → **SQL Editor** and run each file's contents in
filename order (`0001` first). Paste and run one file at a time so any error is
easy to attribute.

### Option C — `psql`

```sh
psql "$DATABASE_URL" -f database/migrations/0001_user_profiles.sql
psql "$DATABASE_URL" -f database/migrations/0002_assistant_conversations.sql
# ... and so on, in order.
```

## Idempotency

Migrations use `create table if not exists`, `create index if not exists`, and
`drop ... if exists` before `create trigger` / `create policy`, so re-running a
file is safe. Two rules still apply:

1. **Never hand-edit a migration that has already been applied** to a shared
   project — add a new numbered migration instead. Editing applied history
   causes drift between environments.
2. `set_updated_at()` is defined in `0001`; if you apply a later file in
   isolation it will fail because the helper does not exist. Apply in order.

## Row Level Security (RLS) model

Every table in this directory has RLS **enabled** and four per-user policies
(`select`, `insert`, `update`, `delete`) that all reduce to:

```sql
auth.uid() = user_id
```

Consequences:

- A browser client using the `anon` or `authenticated` role can only read or
  write rows it owns; `auth.uid()` is derived from the caller's JWT.
- The **service role** key bypasses RLS entirely. The server's admin client
  ([`server/src/services/supabase.ts`](../server/src/services/supabase.ts)) uses
  it, and application code is still responsible for scoping every query by
  `user_id` (defense in depth — see the repositories in
  `server/src/services/`).
- `user_profiles` is keyed by `id` (which *is* the auth user id), so its policy
  uses `auth.uid() = id`; every other table carries an explicit `user_id`.

## Relationships

```
auth.users
  ├─ user_profiles              (1:1, id)
  ├─ assistant_conversations    (1:N)
  │    └─ assistant_messages    (1:N, on delete cascade)
  ├─ assistant_tasks            (1:N)
  │    ├─ assistant_reminders   (1:N, on delete cascade)
  │    └─ assistant_audit_logs  (1:N, task_id on delete set null)
  ├─ notion_connections         (1:1, unique user_id)
  └─ notion_database_mappings   (1:N, unique (user_id, notion_database_id))
```

> These migrations have **not** been run against a live Postgres/Supabase
> instance as part of Phase 6 (no database is available in the dev environment).
> Review them carefully and exercise them against a real Supabase project
> before relying on them.
