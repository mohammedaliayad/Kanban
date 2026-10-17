-- Run once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists public.cards (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.config (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null,
  primary key (user_id, id)
);

alter table public.cards enable row level security;
alter table public.config enable row level security;

-- Each signed-in person only ever sees and changes their own rows.
drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards for all using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own config" on public.config;
create policy "own config" on public.config for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates between phone and laptop.
do $$ begin
  alter publication supabase_realtime add table public.cards, public.config;
exception when duplicate_object then null; end $$;
