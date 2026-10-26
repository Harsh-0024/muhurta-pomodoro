-- Notifications for the iPhone app when it is closed: the Supabase side.
-- (The function is supabase/functions/push; the steps are in supabase/PUSH.md.)
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run again.
--
-- How it fits together
--   * As the iPhone app leaves the screen with a timer running, it books the
--     end of the block here (one row per phone, through the push function).
--     Coming back to the app deletes the row.
--   * Every 10 seconds, pg_cron looks for rows that are due. Only when there
--     is one does it call the push function, which takes them off the table
--     and sends each through Apple's push service.
--   * Nobody reads or writes the table directly: row-level security is on and
--     there are no policies, so only the function (service role) can.

create table if not exists public.push_bookings (
    endpoint    text primary key check (char_length(endpoint) <= 1000),
    p256dh      text not null check (char_length(p256dh) <= 100),
    auth        text not null check (char_length(auth) <= 40),
    fire_at     timestamptz not null,
    title       text not null default '' check (char_length(title) <= 100),
    body        text not null default '' check (char_length(body) <= 300),
    created_at  timestamptz not null default now()
);
create index if not exists push_bookings_fire_at on public.push_bookings (fire_at);

alter table public.push_bookings enable row level security;
revoke all on public.push_bookings from anon, authenticated;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Same name again replaces the job, so running this file twice is fine.
select cron.schedule(
    'muhurta-push',
    '10 seconds',
    $$
    select net.http_post(
        url     := 'https://ybjyzvtilicsncuiujks.supabase.co/functions/v1/push',
        body    := '{"action": "send"}'::jsonb,
        headers := '{"Content-Type": "application/json"}'::jsonb
    )
    where exists (select 1 from public.push_bookings where fire_at <= now());
    $$
);
