-- ============================================================================
-- 0007_notion_database_mappings.sql
-- Phase 6 (Supabase task system): mapping of local purposes -> Notion databases.
--
-- Each user may map several Notion databases, tagging each with a purpose
-- ('work' | 'personal' | 'school' | 'projects' | 'other') and nominating one as
-- the default. A given Notion database can only be mapped once per user.
--
-- NOTE: The Notion integration itself is a later phase; this migration only
-- reserves the persistence layer.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- notion_database_mappings table
-- ---------------------------------------------------------------------------
create table if not exists public.notion_database_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  notion_database_id text not null,
  database_title text,
  purpose text check (purpose in ('work', 'personal', 'school', 'projects', 'other')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A user cannot map the same Notion database twice.
  unique (user_id, notion_database_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists notion_database_mappings_user_id_idx
  on public.notion_database_mappings (user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists notion_database_mappings_set_updated_at on public.notion_database_mappings;
create trigger notion_database_mappings_set_updated_at
  before update on public.notion_database_mappings
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.notion_database_mappings enable row level security;

drop policy if exists "Users can view their own database mappings" on public.notion_database_mappings;
create policy "Users can view their own database mappings"
  on public.notion_database_mappings
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own database mappings" on public.notion_database_mappings;
create policy "Users can insert their own database mappings"
  on public.notion_database_mappings
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own database mappings" on public.notion_database_mappings;
create policy "Users can update their own database mappings"
  on public.notion_database_mappings
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own database mappings" on public.notion_database_mappings;
create policy "Users can delete their own database mappings"
  on public.notion_database_mappings
  for delete
  to authenticated
  using (auth.uid() = user_id);
