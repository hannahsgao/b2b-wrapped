-- Stanford leaderboard auth + table setup for Supabase
-- Run in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.stanford_leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  season integer not null default 2026,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  affiliation text,
  event text not null check (event in ('12K', '15K Breakers Bonus')),
  gender text check (gender in ('M', 'F', 'N')),
  source text not null default 'self' check (source in ('official', 'strava', 'self')),
  chip_seconds integer not null check (chip_seconds > 0 and chip_seconds < 21600),
  chip_time text not null,
  distance_miles numeric(4,2) not null check (distance_miles > 0 and distance_miles < 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists stanford_entries_user_event_season_uniq
  on public.stanford_leaderboard_entries (user_id, event, season);

create index if not exists stanford_entries_event_idx
  on public.stanford_leaderboard_entries (event, season, chip_seconds);

-- Ensure API roles can access the table (RLS still controls row-level permissions).
grant usage on schema public to authenticated;
revoke all on table public.stanford_leaderboard_entries from anon, authenticated;
grant select, insert, update, delete on table public.stanford_leaderboard_entries to authenticated;

create or replace function public.is_stanford_email(email text)
returns boolean
language sql
stable
as $$
  select lower(split_part(coalesce(email, ''), '@', 2)) in ('stanford.edu', 'alumni.stanford.edu');
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stanford_entries_set_updated_at on public.stanford_leaderboard_entries;
create trigger stanford_entries_set_updated_at
before update on public.stanford_leaderboard_entries
for each row
execute function public.set_updated_at();

alter table public.stanford_leaderboard_entries enable row level security;
alter table public.stanford_leaderboard_entries force row level security;

-- Read access: any authenticated Stanford/alumni account.
drop policy if exists stanford_entries_select on public.stanford_leaderboard_entries;
create policy stanford_entries_select
on public.stanford_leaderboard_entries
for select
to authenticated
using (public.is_stanford_email(auth.jwt() ->> 'email'));

-- Insert access: only your own uid/email, Stanford domain only.
drop policy if exists stanford_entries_insert on public.stanford_leaderboard_entries;
create policy stanford_entries_insert
on public.stanford_leaderboard_entries
for insert
to authenticated
with check (
  user_id = auth.uid()
  and lower(email) = lower(auth.jwt() ->> 'email')
  and public.is_stanford_email(auth.jwt() ->> 'email')
);

-- Update access: only your own rows, and user_id/email must remain bound to auth token.
drop policy if exists stanford_entries_update on public.stanford_leaderboard_entries;
create policy stanford_entries_update
on public.stanford_leaderboard_entries
for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_stanford_email(auth.jwt() ->> 'email')
)
with check (
  user_id = auth.uid()
  and lower(email) = lower(auth.jwt() ->> 'email')
  and public.is_stanford_email(auth.jwt() ->> 'email')
);

-- Delete access: only your own rows.
drop policy if exists stanford_entries_delete on public.stanford_leaderboard_entries;
create policy stanford_entries_delete
on public.stanford_leaderboard_entries
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.is_stanford_email(auth.jwt() ->> 'email')
);
