-- Muhurata cloud sync: the Supabase side.
--
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run again: everything is "create if missing" or replaced.
--
-- How it fits together
--   * Every computer keeps its own full copy in SQLite (see migration 0002).
--     This database is where computers exchange changes; it is not the only
--     copy of anyone's data.
--   * The app signs in as the user and talks to these tables directly
--     through Supabase's REST API. Row-level security (bottom of file) means
--     each person can only ever read and write their own rows, so the
--     public "anon" key is safe to ship inside the app.
--   * Rows are never deleted here. A delete on one computer arrives as
--     deleted_at being set, so the other computers delete their copy too.
--   * Newest change wins: an upload that is older than what is already
--     stored is ignored (see keep_newest()).
--   * server_updated_at is stamped by the server on every write. Computers
--     download "everything changed since I last looked" by this column, so a
--     computer with a wrong clock cannot make changes go missing.

-- --------------------------------------------------------------------------
-- tables
-- --------------------------------------------------------------------------
create table if not exists public.activity_segments (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    uuid              uuid not null,
    day               text not null,
    kind              text not null,
    started_at        text not null,
    ended_at          text not null,
    duration_sec      double precision not null,
    productive_sec    double precision not null default 0,
    rest_sec          double precision not null default 0,
    preset_id         text,
    preset_name       text,
    phase_index       integer,
    details_json      text not null default '{}',
    created_at        text not null,
    updated_at        text not null,          -- the computer's change time (newest wins)
    deleted_at        text,                   -- set instead of deleting
    server_updated_at timestamptz not null default now(),
    primary key (user_id, uuid)
);

-- The computer that recorded the session (added later, so it is an
-- ALTER: running this file again upgrades an existing project).
alter table public.activity_segments add column if not exists device_id uuid;

create table if not exists public.custom_presets (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    uuid              uuid not null,
    name              text not null,
    work_min          integer not null,
    short_rest_min    integer not null,
    long_rest_min     integer not null,
    created_at        text not null,
    updated_at        text not null,
    deleted_at        text,
    server_updated_at timestamptz not null default now(),
    primary key (user_id, uuid)
);

-- One settings row per person (not per computer). The app leaves out
-- settings that belong to one computer, such as sound volume.
create table if not exists public.app_settings (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    json              text not null default '{}',
    updated_at        text not null,
    deleted_at        text,                   -- unused; keeps every table the same shape for the app
    server_updated_at timestamptz not null default now(),
    primary key (user_id)
);

-- Focus minutes per day per computer. Each computer only writes its own
-- rows, so totals from several computers add up instead of overwriting.
create table if not exists public.focus_by_device (
    user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
    day               text not null,
    device_id         uuid not null,
    minutes           integer not null default 0,
    updated_at        text not null,
    deleted_at        text,                   -- unused, as above
    server_updated_at timestamptz not null default now(),
    primary key (user_id, day, device_id)
);

-- "What changed since I last looked", per person.
create index if not exists activity_segments_pull on public.activity_segments (user_id, server_updated_at);
create index if not exists custom_presets_pull    on public.custom_presets    (user_id, server_updated_at);
create index if not exists app_settings_pull      on public.app_settings      (user_id, server_updated_at);
create index if not exists focus_by_device_pull   on public.focus_by_device   (user_id, server_updated_at);

-- --------------------------------------------------------------------------
-- newest change wins, and the server stamps every write
-- --------------------------------------------------------------------------
create or replace function public.keep_newest()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' then
        -- An upload older than (or the same as) what is stored changes
        -- nothing. Times are ISO strings in UTC, so text order is time order.
        if new.updated_at <= old.updated_at then
            return null;  -- skip this row's update
        end if;
        new.user_id := old.user_id;  -- a row can never be moved to another person
    end if;
    new.server_updated_at := clock_timestamp();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array['activity_segments', 'custom_presets', 'app_settings', 'focus_by_device'] loop
        execute format('drop trigger if exists keep_newest on public.%I', t);
        execute format(
            'create trigger keep_newest before insert or update on public.%I
             for each row execute function public.keep_newest()', t);
    end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- own rows only
-- --------------------------------------------------------------------------
-- Signed-in people may read, add and change their own rows. There is no
-- delete rule, so nobody can delete rows through the API at all - not even
-- their own, and not by mistake. Signed-out requests ("anon") get nothing.
do $$
declare t text;
begin
    foreach t in array array['activity_segments', 'custom_presets', 'app_settings', 'focus_by_device'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from anon, authenticated', t);
        execute format('grant select, insert, update on public.%I to authenticated', t);
        execute format('drop policy if exists own_rows on public.%I', t);
        execute format(
            'create policy own_rows on public.%I for all to authenticated
             using (user_id = (select auth.uid()))
             with check (user_id = (select auth.uid()))', t);
    end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- profiles: name and username (added with password accounts)
-- --------------------------------------------------------------------------
-- The name and username also live in each account's sign-in record
-- (user_metadata), which is what the app shows. This table exists so that
-- no two people can have the same username.
create table if not exists public.profiles (
    user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
    username   text not null check (username ~ '^[a-z][a-z0-9_.]{2,19}$'),
    first_name text not null default '' check (char_length(first_name) <= 50),
    last_name  text not null default '' check (char_length(last_name) <= 50),
    updated_at timestamptz not null default now()
);
create unique index if not exists profiles_username_unique on public.profiles (lower(username));

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
drop policy if exists own_rows on public.profiles;
create policy own_rows on public.profiles for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- "Is this username free?" while someone is creating an account (so before
-- they are signed in). Answers yes or no only; it never reveals whose name
-- it is, and a person's own current username counts as free for them.
create or replace function public.username_available(name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select not exists (
        select 1 from public.profiles
        where lower(username) = lower(name)
          and user_id is distinct from (select auth.uid())
    );
$$;
revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- app_devices: which version each computer runs (added in 1.7.2)
-- --------------------------------------------------------------------------
-- Each signed-in computer reports its app version, platform and when it was
-- last online, at most every few hours. Nothing else. People can only write
-- their own rows; the owner sees everyone's in the Table Editor, or with:
--   select * from public.devices_overview;
create table if not exists public.app_devices (
    user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
    device_id   uuid not null,
    app_version text not null check (char_length(app_version) <= 20),
    platform    text not null default '' check (char_length(platform) <= 20),
    last_seen   timestamptz not null default now(),
    primary key (user_id, device_id)
);

alter table public.app_devices enable row level security;
revoke all on public.app_devices from anon, authenticated;
grant select, insert, update on public.app_devices to authenticated;
drop policy if exists own_rows on public.app_devices;
create policy own_rows on public.app_devices for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- For the owner only (the dashboard and SQL Editor): who runs what, newest
-- first. Not reachable through the app's API.
create or replace view public.devices_overview
with (security_invoker = on) as
select coalesce(nullif(trim(p.first_name || ' ' || p.last_name), ''), u.email) as person,
       p.username,
       u.email,
       d.app_version,
       d.platform,
       d.last_seen
from public.app_devices d
join auth.users u on u.id = d.user_id
left join public.profiles p on p.user_id = d.user_id
order by d.last_seen desc;
revoke all on public.devices_overview from anon, authenticated;

-- --------------------------------------------------------------------------
-- admin: the owner's view inside the app (added with the Admin tab)
-- --------------------------------------------------------------------------
-- Who is an admin. Not reachable through the API at all (no policies); only
-- the functions below read it. Add yourself once (change the email if your
-- app account uses another):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'harsh242042004@gmail.com'
--   on conflict do nothing;
create table if not exists public.admins (
    user_id  uuid primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

insert into public.admins (user_id)
select id from auth.users where email = 'harsh242042004@gmail.com'
on conflict do nothing;

-- Is the person asking an admin? The app asks this to show the Admin tab.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Update rules, editable from the Admin tab. Every copy of the app reads
-- this (signed in or not); only admins can change it.
create table if not exists public.app_config (
    id               integer primary key default 1 check (id = 1),
    minimum_version  text not null default '' check (minimum_version ~ '^(\d+\.\d+\.\d+)?$'),
    blocked_versions text[] not null default '{}',
    message          text not null default '' check (char_length(message) <= 500),
    updated_at       timestamptz not null default now()
);
insert into public.app_config (id) values (1) on conflict do nothing;
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to anon, authenticated;
grant update (minimum_version, blocked_versions, message, updated_at) on public.app_config to authenticated;
drop policy if exists read_all on public.app_config;
create policy read_all on public.app_config for select to anon, authenticated using (true);
drop policy if exists admins_edit on public.app_config;
create policy admins_edit on public.app_config for update to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- Everything the Admin tab shows, in one call, for admins only.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admins only' using errcode = '42501';
    end if;
    return json_build_object(
        'people', (
            select coalesce(json_agg(t order by t.last_seen desc nulls last, t.created_at desc), '[]'::json)
            from (
                select u.id,
                       u.email,
                       u.created_at,
                       u.last_sign_in_at,
                       coalesce(p.first_name, '') as first_name,
                       coalesce(p.last_name, '')  as last_name,
                       coalesce(p.username, '')   as username,
                       exists (select 1 from public.admins a where a.user_id = u.id) as is_admin,
                       (select max(d.last_seen) from public.app_devices d where d.user_id = u.id) as last_seen,
                       (select count(*) from public.app_devices d where d.user_id = u.id) as computers,
                       (select coalesce(sum(f.minutes), 0) from public.focus_by_device f
                         where f.user_id = u.id and f.deleted_at is null) as focus_minutes,
                       (select count(*) from public.activity_segments s
                         where s.user_id = u.id and s.deleted_at is null and s.kind = 'work') as sessions,
                       (select max(s.started_at) from public.activity_segments s
                         where s.user_id = u.id and s.deleted_at is null) as last_session
                from auth.users u
                left join public.profiles p on p.user_id = u.id
            ) t
        ),
        'devices', (
            select coalesce(json_agg(t order by t.last_seen desc), '[]'::json)
            from (
                select d.user_id,
                       coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email) as person,
                       d.device_id, d.app_version, d.platform, d.last_seen
                from public.app_devices d
                join auth.users u on u.id = d.user_id
                left join public.profiles p on p.user_id = d.user_id
            ) t
        ),
        'policy', (select row_to_json(c) from public.app_config c where c.id = 1)
    );
end;
$$;
revoke all on function public.admin_overview() from public;
grant execute on function public.admin_overview() to authenticated;

-- --------------------------------------------------------------------------
-- feedback: what people like, dislike, would improve or want next
-- --------------------------------------------------------------------------
-- Sent from Settings -> Feedback. People can add feedback and read their own
-- (to see whether it was read); they can't change or delete it. Admins read
-- everyone's, mark it done and delete it through the functions below.
create table if not exists public.feedback (
    id          bigint generated always as identity primary key,
    user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
    kind        text not null check (kind in ('like', 'dislike', 'improve', 'idea')),
    message     text not null check (char_length(btrim(message)) between 1 and 2000),
    app_version text not null default '' check (char_length(app_version) <= 20),
    platform    text not null default '' check (char_length(platform) <= 20),
    status      text not null default 'new' check (status in ('new', 'seen', 'done')),
    created_at  timestamptz not null default now()
);
create index if not exists feedback_user on public.feedback (user_id, created_at desc);
create index if not exists feedback_newest on public.feedback (created_at desc);

alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;
-- Only these columns: nobody can send feedback that is already "done".
grant insert (kind, message, app_version, platform) on public.feedback to authenticated;
drop policy if exists own_read on public.feedback;
create policy own_read on public.feedback for select to authenticated
    using (user_id = (select auth.uid()));
drop policy if exists own_insert on public.feedback;
create policy own_insert on public.feedback for insert to authenticated
    with check (user_id = (select auth.uid()));

-- Everyone's feedback with who sent it, newest first, for admins only.
create or replace function public.admin_feedback()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admins only' using errcode = '42501';
    end if;
    return (
        select coalesce(json_agg(t order by t.created_at desc), '[]'::json)
        from (
            select f.id, f.kind, f.message, f.app_version, f.platform, f.status, f.created_at,
                   f.user_id,
                   u.email,
                   coalesce(p.first_name, '') as first_name,
                   coalesce(p.last_name, '')  as last_name,
                   coalesce(p.username, '')   as username
            from public.feedback f
            join auth.users u on u.id = f.user_id
            left join public.profiles p on p.user_id = f.user_id
        ) t
    );
end;
$$;
revoke all on function public.admin_feedback() from public;
grant execute on function public.admin_feedback() to authenticated;

-- Mark feedback seen, done or open again. Returns false if it no longer exists.
create or replace function public.admin_set_feedback_status(feedback_id bigint, new_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admins only' using errcode = '42501';
    end if;
    if new_status not in ('new', 'seen', 'done') then
        raise exception 'unknown status' using errcode = '22023';
    end if;
    update public.feedback set status = new_status where id = feedback_id;
    return found;
end;
$$;
revoke all on function public.admin_set_feedback_status(bigint, text) from public;
grant execute on function public.admin_set_feedback_status(bigint, text) to authenticated;

-- What was new when the admin opened it is now seen, so the sender knows it was read.
create or replace function public.admin_mark_feedback_seen(feedback_ids bigint[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admins only' using errcode = '42501';
    end if;
    update public.feedback set status = 'seen' where id = any(feedback_ids) and status = 'new';
end;
$$;
revoke all on function public.admin_mark_feedback_seen(bigint[]) from public;
grant execute on function public.admin_mark_feedback_seen(bigint[]) to authenticated;

create or replace function public.admin_delete_feedback(feedback_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admins only' using errcode = '42501';
    end if;
    delete from public.feedback where id = feedback_id;
    return found;
end;
$$;
revoke all on function public.admin_delete_feedback(bigint) from public;
grant execute on function public.admin_delete_feedback(bigint) to authenticated;
