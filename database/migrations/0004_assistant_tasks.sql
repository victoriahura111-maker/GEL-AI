-- ============================================================================
-- 0004_assistant_tasks.sql
-- Phase 6 (Supabase task system): local task mirror.
--
-- Supabase is the automation/reminder layer, not the source of truth for task
-- content — Notion remains the external workspace. Rows here mirror the tasks
-- the assistant knows about, carrying the Notion identifiers needed to
-- reconcile later (Phase 7+). Notion sync columns are populated in later
-- phases; they are nullable here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_tasks table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  -- Ownership. Deleting the auth user removes all of their task mirrors.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- External Notion identity (nullable until a task has been mirrored).
  notion_page_id text,
  notion_database_id text,
  notion_url text,
  title text not null,
  description text,
  category text,
  priority text check (priority in ('low', 'medium', 'high')),
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue')),
  due_date date,
  due_time time,
  timezone text,
  -- Which system produced the most recent change (audit/provenance).
  source_of_change text check (source_of_change in ('assistant', 'notion', 'system')),
  -- Free-form sync bookkeeping (e.g. 'pending' | 'synced' | 'out_of_sync' | 'error').
  sync_status text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists assistant_tasks_user_id_idx
  on public.assistant_tasks (user_id);
create index if not exists assistant_tasks_due_date_idx
  on public.assistant_tasks (due_date);
create index if not exists assistant_tasks_status_idx
  on public.assistant_tasks (status);
create index if not exists assistant_tasks_notion_database_id_idx
  on public.assistant_tasks (notion_database_id);
-- A given Notion page maps to at most one local task per user. The partial
-- predicate keeps the index usable and ignores rows that have no page id yet.
create unique index if not exists assistant_tasks_user_notion_page_uidx
  on public.assistant_tasks (user_id, notion_page_id)
  where notion_page_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists assistant_tasks_set_updated_at on public.assistant_tasks;
create trigger assistant_tasks_set_updated_at
  before update on public.assistant_tasks
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.assistant_tasks enable row level security;

drop policy if exists "Users can view their own tasks" on public.assistant_tasks;
create policy "Users can view their own tasks"
  on public.assistant_tasks
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own tasks" on public.assistant_tasks;
create policy "Users can insert their own tasks"
  on public.assistant_tasks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own tasks" on public.assistant_tasks;
create policy "Users can update their own tasks"
  on public.assistant_tasks
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own tasks" on public.assistant_tasks;
create policy "Users can delete their own tasks"
  on public.assistant_tasks
  for delete
  to authenticated
  using (auth.uid() = user_id);
