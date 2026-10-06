-- ============================================================================
-- 0006_notion_connections.sql
-- Phase 6 (Supabase task system): Notion OAuth connection storage.
--
-- Exactly one connection per user. The access token is stored encrypted at the
-- application layer; this column only ever holds ciphertext (never a raw
-- token), and the encryption key stays in the server environment.
--
-- NOTE: The Notion integration itself is a later phase; this migration only
-- reserves the persistence layer.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- notion_connections table
-- ---------------------------------------------------------------------------
create table if not exists public.notion_connections (
  id uuid primary key default gen_random_uuid(),
  -- One connection per user (creates a unique index on user_id).
  user_id uuid not null unique references auth.users (id) on delete cascade,
  access_token_encrypted text not null,
  bot_id text,
  workspace_id text,
  workspace_name text,
  workspace_icon text,
  -- Raw OAuth "owner" payload (type/user/workspace) for auditing/debugging.
  owner jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- `user_id` is already indexed by the UNIQUE constraint above; add lookups by
-- workspace for admin/ops reconciliation.
create index if not exists notion_connections_workspace_id_idx
  on public.notion_connections (workspace_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists notion_connections_set_updated_at on public.notion_connections;
create trigger notion_connections_set_updated_at
  before update on public.notion_connections
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.notion_connections enable row level security;

drop policy if exists "Users can view their own notion connection" on public.notion_connections;
create policy "Users can view their own notion connection"
  on public.notion_connections
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own notion connection" on public.notion_connections;
create policy "Users can insert their own notion connection"
  on public.notion_connections
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own notion connection" on public.notion_connections;
create policy "Users can update their own notion connection"
  on public.notion_connections
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own notion connection" on public.notion_connections;
create policy "Users can delete their own notion connection"
  on public.notion_connections
  for delete
  to authenticated
  using (auth.uid() = user_id);
