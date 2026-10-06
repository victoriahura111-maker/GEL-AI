-- ============================================================================
-- 0010_task_follow_ups.sql
-- Phase 15 (Follow-up engine): anti-spam + conversational state on tasks.
--
-- The follow-up engine chases open tasks that are due soon or overdue. To
-- avoid spamming a user, each task carries the bookkeeping below:
--
--  - `last_follow_up_at`  — when a follow-up was last sent (min-interval guard).
--  - `follow_up_count`    — how many follow-ups have been sent (hard cap).
--  - `awaiting_follow_up` — true while the assistant is waiting for the user's
--                           answer to the most recent follow-up (also surfaced
--                           by the dashboard's "Awaiting Update" bucket).
--  - `blocking_reason`    — the user-supplied reason a task is blocked.
--
-- These are additive and nullable/defaulted so existing rows keep working and
-- previously-created tasks are immediately eligible for follow-up.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New columns (idempotent)
-- ---------------------------------------------------------------------------
alter table public.assistant_tasks
  add column if not exists last_follow_up_at timestamptz;
alter table public.assistant_tasks
  add column if not exists follow_up_count integer not null default 0;
alter table public.assistant_tasks
  add column if not exists blocking_reason text;
alter table public.assistant_tasks
  add column if not exists awaiting_follow_up boolean not null default false;

-- ---------------------------------------------------------------------------
-- Index supporting follow-up candidate queries
-- ---------------------------------------------------------------------------
-- The worker scans open tasks by due date; a composite (user_id, status,
-- due_date) index keeps that scan cheap as the table grows.
create index if not exists assistant_tasks_follow_up_idx
  on public.assistant_tasks (user_id, status, due_date);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- No policy changes: the table already has per-user RLS and the new columns
-- are covered by the existing row policies.
