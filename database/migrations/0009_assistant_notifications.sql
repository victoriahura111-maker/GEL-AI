-- ============================================================================
-- 0009_assistant_notifications.sql
-- Phase 14 (Notification system): the per-user notification center.
--
-- One row per delivered (or recorded) notification. The `in_app` channel writes
-- an `unread` row here *and* appends a proactive assistant message, so the same
-- event shows up both in the notification bell and in the chat.
--
-- `status` is deliberately a small state machine (`unread`/`read`); richer
-- delivery state (sent/failed per channel) is logged by the reminder engine and
-- the audit trail, not here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_notifications table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_notifications (
  id uuid primary key default gen_random_uuid(),
  -- Ownership. Deleting the auth user removes all of their notifications.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Logical kind, e.g. 'reminder' | 'follow_up' | 'task_update' | 'system'.
  type text not null,
  title text not null,
  body text,
  -- Delivery channel that produced the row (in_app today; email/push later).
  channel text not null default 'in_app',
  status text not null default 'unread'
    check (status in ('unread', 'read')),
  -- Soft reference: the notification survives if the task is deleted.
  task_id uuid references public.assistant_tasks (id) on delete set null,
  notion_url text,
  -- Non-sensitive delivery metadata (e.g. reminder id). Never a token/payload.
  metadata jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Bell badge: "how many unread for this user".
create index if not exists assistant_notifications_user_status_created_idx
  on public.assistant_notifications (user_id, status, created_at desc);
-- Notification list: newest-first per user.
create index if not exists assistant_notifications_user_created_idx
  on public.assistant_notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists assistant_notifications_set_updated_at on public.assistant_notifications;
create trigger assistant_notifications_set_updated_at
  before update on public.assistant_notifications
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.assistant_notifications enable row level security;

drop policy if exists "Users can view their own notifications" on public.assistant_notifications;
create policy "Users can view their own notifications"
  on public.assistant_notifications
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own notifications" on public.assistant_notifications;
create policy "Users can insert their own notifications"
  on public.assistant_notifications
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own notifications" on public.assistant_notifications;
create policy "Users can update their own notifications"
  on public.assistant_notifications
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own notifications" on public.assistant_notifications;
create policy "Users can delete their own notifications"
  on public.assistant_notifications
  for delete
  to authenticated
  using (auth.uid() = user_id);
