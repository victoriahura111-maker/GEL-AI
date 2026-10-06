-- ============================================================================
-- 0005_assistant_reminders.sql
-- Phase 6 (Supabase task system): reminder schedule records.
--
-- Reminders are stored here for later execution phases; this migration only
-- defines the schema (no scheduling or delivery logic is implemented yet).
-- Recurrence is intentionally a nullable free-form string so a future phase can
-- introduce 'daily'/'weekly' without a schema change.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_reminders table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_reminders (
  id uuid primary key default gen_random_uuid(),
  -- Deleting the parent task removes its reminders.
  task_id uuid not null references public.assistant_tasks (id) on delete cascade,
  -- Ownership. Deleting the auth user removes all of their reminders.
  user_id uuid not null references auth.users (id) on delete cascade,
  scheduled_for timestamptz not null,
  timezone text,
  channel text not null default 'in_app',
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'cancelled')),
  -- Null = one-shot; future phases may use 'daily' / 'weekly'.
  recurrence text,
  sent_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Primary scheduler access pattern: "what is due to run next".
create index if not exists assistant_reminders_status_scheduled_idx
  on public.assistant_reminders (status, scheduled_for);
create index if not exists assistant_reminders_user_id_idx
  on public.assistant_reminders (user_id);
create index if not exists assistant_reminders_task_id_idx
  on public.assistant_reminders (task_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists assistant_reminders_set_updated_at on public.assistant_reminders;
create trigger assistant_reminders_set_updated_at
  before update on public.assistant_reminders
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.assistant_reminders enable row level security;

drop policy if exists "Users can view their own reminders" on public.assistant_reminders;
create policy "Users can view their own reminders"
  on public.assistant_reminders
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own reminders" on public.assistant_reminders;
create policy "Users can insert their own reminders"
  on public.assistant_reminders
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own reminders" on public.assistant_reminders;
create policy "Users can update their own reminders"
  on public.assistant_reminders
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own reminders" on public.assistant_reminders;
create policy "Users can delete their own reminders"
  on public.assistant_reminders
  for delete
  to authenticated
  using (auth.uid() = user_id);
