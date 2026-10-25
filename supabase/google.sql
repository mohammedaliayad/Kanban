-- Google Calendar + Tasks sync for Orbit Ai. Safe to run more than once.
create extension if not exists pg_net;

-- One connected Google account per area (life, idlvr, rockbuild). Only the edge functions read this.
create table if not exists public.google_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  board text not null,
  email text,
  refresh_token text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, board)
);
create table if not exists public.google_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  board text not null,
  created_at timestamptz not null default now()
);
-- Which Google event or task belongs to which card.
create table if not exists public.google_sync_map (
  card_id text not null,
  kind text not null,          -- 'due' (all-day event), 'event' (timed event) or 'task' (Google Task)
  user_id uuid not null,
  board text not null,
  google_id text not null,
  hash text,
  primary key (card_id, kind)
);
alter table public.google_accounts enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.google_sync_map enable row level security;
-- No policies: the browser can't read tokens; the edge functions use the service role.

-- Every change to a card pings the google-sync function.
create or replace function public.cards_to_google() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://scnxwvkvpfzuaazxhfrs.supabase.co/functions/v1/google-sync',
    body := jsonb_build_object('id', coalesce(new.id, old.id)),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  return null;
end $$;
drop trigger if exists cards_to_google on public.cards;
create trigger cards_to_google after insert or update or delete on public.cards
  for each row execute function public.cards_to_google();
