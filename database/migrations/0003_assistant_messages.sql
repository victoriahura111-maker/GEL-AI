-- ============================================================================
-- 0003_assistant_messages.sql
-- Phase 6 (Supabase task system): individual conversation messages.
--
-- Each message belongs to a conversation and (denormalized) to the owning user
-- so that every row can be scoped by `user_id` alone, and so RLS policies do
-- not need a join back to the parent conversation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assistant_messages table
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  -- Deleting a conversation removes its messages.
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  -- Ownership. Deleting the auth user removes all of their messages.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Only the two conversational roles are valid.
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Optional structured UI cards (task/reminder/...) rendered by the client.
  cards jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Primary access pattern: replay a conversation in chronological order.
create index if not exists assistant_messages_conversation_created_idx
  on public.assistant_messages (conversation_id, created_at);
-- Secondary: user-wide scans / cleanup.
create index if not exists assistant_messages_user_id_idx
  on public.assistant_messages (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.assistant_messages enable row level security;

drop policy if exists "Users can view their own messages" on public.assistant_messages;
create policy "Users can view their own messages"
  on public.assistant_messages
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own messages" on public.assistant_messages;
create policy "Users can insert their own messages"
  on public.assistant_messages
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own messages" on public.assistant_messages;
create policy "Users can update their own messages"
  on public.assistant_messages
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own messages" on public.assistant_messages;
create policy "Users can delete their own messages"
  on public.assistant_messages
  for delete
  to authenticated
  using (auth.uid() = user_id);
