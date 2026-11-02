-- MATHERZAT database schema
-- Run this once in Supabase -> SQL Editor.

create table if not exists public.quiz_rooms (
  code text primary key check (char_length(code) = 6),
  title text not null default 'Математика тесті',
  status text not null default 'lobby' check (status in ('lobby', 'running', 'finished')),
  questions jsonb not null default '[]'::jsonb,
  players jsonb not null default '[]'::jsonb,
  current_index integer not null default -1,
  question_started_at timestamptz,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.quiz_rooms enable row level security;
revoke all on table public.quiz_rooms from anon, authenticated;
grant all on table public.quiz_rooms to service_role;

create index if not exists quiz_rooms_created_at_idx
  on public.quiz_rooms (created_at desc);
