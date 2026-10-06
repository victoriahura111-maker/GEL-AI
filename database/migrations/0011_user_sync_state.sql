-- ============================================================================
-- 0011_user_sync_state.sql
-- Phase 16 (Synchronization): per-user Notion ↔ local sync watermark.
--
-- The sync engine reconciles the local `assistant_tasks` mirror with Notion.
-- To avoid re-scanning every page on every run it remembers, per user:
--
--  - `last_synced_at`  — the watermark: the instant of the last *successful*
--                        pull pass. The Notion `/databases/:id/query` call is
--                        filtered by `last_edited_time after` this value, so a
--                        later tick only sees pages changed since. Null/absent
--                        means "never synced" and the engine uses the epoch.
--  - `last_direction`  — the direction of the most recent run (`both|pull|push`).
--  - `last_error`      — a single, user-safe message for the most recent failure
--                        (never a raw Notion payload, never a token).
--  - `recent_errors`   — a bounded JSON array of the most recent user-safe error
--                        messages, surfaced by `GET /api/sync/status`.
--
-- One row per user (unique on `user_id`), RLS per user like every other table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- user_sync_state table
-- ---------------------------------------------------------------------------
create table if not exists public.user_sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  last_synced_at timestamptz,
  last_direction text check (last_direction in ('both', 'pull', 'push')),
  last_error text,
  recent_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- `user_id` is uniquely indexed by the constraint; no further index is needed
-- because every read is a single-row lookup for the authenticated user.

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists user_sync_state_set_updated_at on public.user_sync_state;
create trigger user_sync_state_set_updated_at
  before update on public.user_sync_state
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_sync_state enable row level security;

drop policy if exists "Users can view their own sync state" on public.user_sync_state;
create policy "Users can view their own sync state"
  on public.user_sync_state
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own sync state" on public.user_sync_state;
create policy "Users can insert their own sync state"
  on public.user_sync_state
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own sync state" on public.user_sync_state;
create policy "Users can update their own sync state"
  on public.user_sync_state
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own sync state" on public.user_sync_state;
create policy "Users can delete their own sync state"
  on public.user_sync_state
  for delete
  to authenticated
  using (auth.uid() = user_id);
