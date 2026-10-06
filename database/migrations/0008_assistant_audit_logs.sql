-- ============================================================================
-- 0008_assistant_audit_logs.sql
-- Phase 6 (Supabase task system): append-only audit trail for assistant actions.
--
-- Records every assistant/tool action so that later phases (Notion sync, tool
-- execution, reminders) can be traced. Rows are immutable in practice; the
-- table intentionally has no `updated_at`.
--
-- `task_id` is a soft reference: if the mirrored task is deleted the audit row
-- survives with a NULL task_id (history is more valuable than referential
-- strictness here).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_audit_logs table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_audit_logs (
  id uuid primary key default gen_random_uuid(),
  -- Ownership. Deleting the auth user removes all of their audit history.
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  -- Soft reference to the mirrored task (no hard FK enforcement on delete).
  task_id uuid references public.assistant_tasks (id) on delete set null,
  notion_page_id text,
  tool_name text,
  -- Arbitrary structured context for the action (prompt intent, diff, ...).
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Primary access pattern: a user's history, newest first.
create index if not exists assistant_audit_logs_user_created_idx
  on public.assistant_audit_logs (user_id, created_at desc);
create index if not exists assistant_audit_logs_task_id_idx
  on public.assistant_audit_logs (task_id);
create index if not exists assistant_audit_logs_notion_page_id_idx
  on public.assistant_audit_logs (notion_page_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.assistant_audit_logs enable row level security;

drop policy if exists "Users can view their own audit logs" on public.assistant_audit_logs;
create policy "Users can view their own audit logs"
  on public.assistant_audit_logs
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own audit logs" on public.assistant_audit_logs;
create policy "Users can insert their own audit logs"
  on public.assistant_audit_logs
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own audit logs" on public.assistant_audit_logs;
create policy "Users can update their own audit logs"
  on public.assistant_audit_logs
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own audit logs" on public.assistant_audit_logs;
create policy "Users can delete their own audit logs"
  on public.assistant_audit_logs
  for delete
  to authenticated
  using (auth.uid() = user_id);
