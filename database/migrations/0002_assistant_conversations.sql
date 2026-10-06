-- ============================================================================
-- 0002_assistant_conversations.sql
-- Phase 6 (Supabase task system): chat conversations.
--
-- A conversation groups the alternating user/assistant messages that make up a
-- single assistant thread. Every conversation belongs to exactly one auth user.
--
-- Depends on:
--   * public.set_updated_at()  (created in 0001_user_profiles.sql)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_conversations table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  -- Ownership. Deleting the auth user removes all of their conversations.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Optional human-readable title (currently set lazily; nullable for now).
  title text,
  -- Timestamp of the most recent message; used for conversation ordering.
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Fetches "my conversations", newest activity first.
create index if not exists assistant_conversations_user_id_idx
  on public.assistant_conversations (user_id);
create index if not exists assistant_conversations_user_last_message_idx
  on public.assistant_conversations (user_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (reuses the shared helper from 0001)
-- ---------------------------------------------------------------------------
drop trigger if exists assistant_conversations_set_updated_at on public.assistant_conversations;
create trigger assistant_conversations_set_updated_at
  before update on public.assistant_conversations
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The server uses the service role (bypasses RLS) for admin work; browser
-- clients (authenticated role) only ever see/modify their own rows.
-- ---------------------------------------------------------------------------
alter table public.assistant_conversations enable row level security;

drop policy if exists "Users can view their own conversations" on public.assistant_conversations;
create policy "Users can view their own conversations"
  on public.assistant_conversations
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own conversations" on public.assistant_conversations;
create policy "Users can insert their own conversations"
  on public.assistant_conversations
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own conversations" on public.assistant_conversations;
create policy "Users can update their own conversations"
  on public.assistant_conversations
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own conversations" on public.assistant_conversations;
create policy "Users can delete their own conversations"
  on public.assistant_conversations
  for delete
  to authenticated
  using (auth.uid() = user_id);
