-- ============================================================================
-- 0001_user_profiles.sql
-- Phase 2 (Authentication): public profiles table, Row Level Security, and
-- triggers that keep profiles in sync with auth.users.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- user_profiles table
-- ---------------------------------------------------------------------------
-- One row per auth.users row. `id` is the primary key and foreign key into
-- auth.users so a deleted auth user cascades to remove their profile.
-- ---------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for lookups by email (admin/ops and future feature queries).
create index if not exists user_profiles_email_idx on public.user_profiles (email);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
-- Keeps `updated_at` current on every UPDATE without requiring application
-- code to remember to set it.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Enable RLS so browser clients (anon/authenticated roles) can only reach
-- their own rows. The service role key bypasses RLS entirely, which is how
-- the server-side admin client performs profile management.
-- ---------------------------------------------------------------------------
alter table public.user_profiles enable row level security;

create policy "Users can view their own profile"
  on public.user_profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy "Users can insert their own profile"
  on public.user_profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.user_profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- handle_new_user trigger
-- ---------------------------------------------------------------------------
-- Canonical Supabase pattern: when a row is inserted into auth.users, create
-- the matching profile row automatically. It is declared SECURITY DEFINER so
-- it runs with the privileges of its owner (typically the role that executes
-- migrations, e.g. postgres) and can therefore read auth.users and write to
-- public.user_profiles regardless of the calling role. `search_path` is set
-- explicitly to avoid search-path hijacking on SECURITY DEFINER functions.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
