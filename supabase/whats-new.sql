-- Saved "What's new" summaries: the Supabase side of supabase/functions/whats-new.
-- (Steps in supabase/WHATS-NEW.md.)
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run again.
--
-- One row per update jump and device ("1.12.0>1.16.0:android"): the summary
-- the first AI wrote, given to everyone making the same jump. Only the
-- function (service role) reads and writes it: row-level security is on and
-- there are no policies. Delete a row to have that summary written again.

create table if not exists public.whats_new_summaries (
    key         text primary key check (char_length(key) <= 60),
    lines       jsonb not null check (jsonb_typeof(lines) = 'array'),
    source      text not null default '' check (char_length(source) <= 20),
    created_at  timestamptz not null default now()
);

alter table public.whats_new_summaries enable row level security;
revoke all on public.whats_new_summaries from anon, authenticated;
-- The function's own key (service role) reads and writes it. Newer Supabase
-- projects no longer grant that by default.
grant select, insert, update on public.whats_new_summaries to service_role;
