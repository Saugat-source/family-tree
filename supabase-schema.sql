-- =====================================================================
-- Family Tree database setup for Supabase
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Run it once, on a new project.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Member accounts (one row per person who signs up)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  email       text,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected')),
  -- admin:  everything, including approving members and changing roles
  -- editor: add, edit and delete anyone in the tree
  -- member: add people, edit the people they added and themselves
  -- viewer: look only
  role        text not null default 'member'
              check (role in ('admin', 'editor', 'member', 'viewer')),
  created_at  timestamptz not null default now()
);

-- Create a "pending" profile automatically whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper checks used by the access rules below.
create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  );
$$;

create or replace function public.has_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved' and role = any (roles)
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role(array['admin']); $$;

create or replace function public.can_edit_all()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role(array['admin', 'editor']); $$;

create or replace function public.can_contribute()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role(array['admin', 'editor', 'member']); $$;

-- Never let the last admin be demoted or removed, so nobody gets locked out.
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'admin' and old.status = 'approved'
     and (tg_op = 'DELETE' or new.role <> 'admin' or new.status <> 'approved')
     and not exists (
       select 1 from public.profiles
       where role = 'admin' and status = 'approved' and id <> old.id
     ) then
    raise exception 'There must always be at least one admin. Make someone else an admin first.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger profiles_guard
  before update or delete on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------
-- 2. People in the family tree
-- ---------------------------------------------------------------------
create table public.persons (
  id              uuid primary key default gen_random_uuid(),
  parent_id       uuid references public.persons (id) on delete restrict,       -- parent in the family line
  other_parent_id uuid references public.persons (id) on delete set null,      -- the parent's spouse (mother or father)
  spouse_of       uuid references public.persons (id) on delete cascade,       -- set for someone who married into the family
  full_name       text not null check (length(trim(full_name)) > 0),
  gender          text check (gender in ('male', 'female', 'other')),
  birth_date      date,
  is_living       boolean not null default true,
  death_date      date,
  birth_place     text,
  current_address text,
  occupation      text,
  phone           text,
  email           text,
  spouse_name     text,
  bio             text,
  photo_path      text,
  user_id         uuid references auth.users (id) on delete set null,  -- the member account this person IS
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint not_own_parent check (parent_id is null or parent_id <> id),
  constraint not_own_spouse check (spouse_of is null or spouse_of <> id),
  constraint spouse_not_in_line check (spouse_of is null or parent_id is null)
);

create index persons_parent_idx on public.persons (parent_id);
create index persons_spouse_idx on public.persons (spouse_of);
-- One member account can be linked to only one person in the tree.
create unique index persons_user_idx on public.persons (user_id) where user_id is not null;

-- Stop non-admins from taking over entries or linking them to other accounts.
create or replace function public.persons_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if tg_op = 'INSERT' then
      if new.user_id is not null and new.user_id <> auth.uid() then
        raise exception 'You can only link a person to your own account';
      end if;
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
      if new.user_id is distinct from old.user_id then
        if old.user_id is not null and old.user_id <> auth.uid() then
          raise exception 'This person is linked to another member';
        end if;
        if new.user_id is not null and new.user_id <> auth.uid() then
          raise exception 'You can only link a person to your own account';
        end if;
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger persons_guard
  before insert or update on public.persons
  for each row execute function public.persons_guard();

-- ---------------------------------------------------------------------
-- 3. Access rules (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.persons  enable row level security;

-- Signed-in users reach the tables through the API; the policies below decide what they see.
grant usage on schema public to anon, authenticated;
grant select, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.persons to authenticated;
grant execute on function public.is_approved(), public.is_admin(), public.can_edit_all(),
  public.can_contribute(), public.has_role(text[]) to authenticated;

-- Members see their own account; admins see everyone's.
create policy "read own profile, admin reads all" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
-- Only admins approve members and change roles.
create policy "admin updates profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());
create policy "admin deletes profiles" on public.profiles
  for delete using (public.is_admin());

-- Every approved member (any role) can see the tree.
create policy "approved members read tree" on public.persons
  for select using (public.is_approved());
-- Admins, editors and members can add children and spouses; only admins and editors add new top ancestors.
create policy "contributors add people" on public.persons
  for insert with check (
    public.can_contribute()
    and (parent_id is not null or spouse_of is not null or public.can_edit_all())
  );
-- Admins and editors edit anyone; members edit the people they added and themselves.
create policy "edit entries" on public.persons
  for update
  using (public.can_edit_all() or (public.can_contribute() and (created_by = auth.uid() or user_id = auth.uid())))
  with check (public.can_contribute());
-- Admins and editors delete people.
create policy "editors delete people" on public.persons
  for delete using (public.can_edit_all());

-- ---------------------------------------------------------------------
-- 4. Photo storage (private: only approved members can view)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "approved members view photos" on storage.objects
  for select using (bucket_id = 'photos' and public.is_approved());
create policy "contributors upload own photos" on storage.objects
  for insert with check (
    bucket_id = 'photos' and public.can_contribute()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "update own photos, editors any" on storage.objects
  for update using (
    bucket_id = 'photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.can_edit_all())
  );
create policy "delete own photos, editors any" on storage.objects
  for delete using (
    bucket_id = 'photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.can_edit_all())
  );

-- ---------------------------------------------------------------------
-- 5. Starting family line
--    Gangaram Shrestha had four sons; one line is filled in here.
--    Members from the other three branches add their own ancestors.
--    Saugat is added as an entry; after signing up, edit it and tick
--    "This is me" to link it to your account.
-- ---------------------------------------------------------------------
do $$
declare
  gangaram uuid; kuber uuid; ratna uuid; dal uuid; santa uuid;
begin
  insert into public.persons (full_name, gender, is_living, bio)
    values ('Gangaram Shrestha', 'male', false, 'Root ancestor of the family. Father of four sons.')
    returning id into gangaram;
  insert into public.persons (parent_id, full_name, gender, is_living)
    values (gangaram, 'Kuber Shrestha', 'male', false) returning id into kuber;
  insert into public.persons (parent_id, full_name, gender, is_living)
    values (kuber, 'Ratna Bahadur Shrestha', 'male', false) returning id into ratna;
  insert into public.persons (parent_id, full_name, gender)
    values (ratna, 'Dal Bahadur Shrestha', 'male') returning id into dal;
  insert into public.persons (parent_id, full_name, gender)
    values (dal, 'Santa Bahadur Shrestha', 'male') returning id into santa;
  insert into public.persons (parent_id, full_name, gender)
    values (santa, 'Saugat Shrestha', 'male');
end;
$$;

-- ---------------------------------------------------------------------
-- 6. "This is me": an approved member links their account to an entry
--    someone else added (used by the Connect me guide).
-- ---------------------------------------------------------------------
create or replace function public.claim_person(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_contribute() then
    raise exception 'Your account cannot add to the tree';
  end if;
  if exists (select 1 from public.persons where user_id = auth.uid()) then
    raise exception 'Your account is already linked to someone in the tree';
  end if;
  update public.persons set user_id = auth.uid() where id = target and user_id is null;
  if not found then
    raise exception 'This person is already linked to another member';
  end if;
end;
$$;

revoke execute on function public.claim_person(uuid) from public, anon;
grant execute on function public.claim_person(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Site name and welcome line (admins change them on Members & roles)
-- ---------------------------------------------------------------------
create table public.site_settings (
  id          smallint primary key default 1 check (id = 1),  -- always exactly one row
  title_en    text not null default 'Family Tree',
  title_ne    text,
  tagline_en  text,
  tagline_ne  text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

alter table public.site_settings enable row level security;
grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;

-- The login page shows the name before anyone signs in, so everyone may read it.
create policy "anyone reads site settings" on public.site_settings
  for select using (true);
create policy "admins update site settings" on public.site_settings
  for update using (public.is_admin()) with check (public.is_admin());

insert into public.site_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 8. Family group chat (text, photos, short videos, audio, files)
-- ---------------------------------------------------------------------

create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  sender_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_name text not null default '',
  body        text check (body is null or length(body) <= 4000),
  file_path   text,                                   -- in the private 'chat' storage bucket
  file_kind   text check (file_kind in ('image', 'video', 'audio', 'file')),
  file_name   text,
  file_size   integer,
  file_type   text,
  duration    real,                                   -- seconds, for video and audio
  created_at  timestamptz not null default now(),
  constraint message_not_empty check (coalesce(length(trim(body)), 0) > 0 or file_path is not null)
);

create index messages_created_idx on public.messages (created_at desc);

-- The sender, their name and the time are filled in here, so nobody can post as someone else.
create or replace function public.messages_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.sender_id := auth.uid();
  new.sender_name := coalesce((select full_name from public.profiles where id = auth.uid()), '');
  new.created_at := now();
  return new;
end;
$$;

create trigger messages_fill
  before insert on public.messages
  for each row execute function public.messages_fill();

alter table public.messages enable row level security;
grant select, insert, delete on public.messages to authenticated;

-- Every approved member (any role) can read and write in the family chat.
create policy "members read chat" on public.messages
  for select using (public.is_approved());
create policy "members send chat" on public.messages
  for insert with check (public.is_approved());
-- People delete their own messages; admins can delete any.
create policy "delete own message, admin any" on public.messages
  for delete using (public.is_approved() and (sender_id = auth.uid() or public.is_admin()));

-- New messages appear for everyone straight away.
alter publication supabase_realtime add table public.messages;

-- Chat files: private, up to 50 MB each, only approved members can see them.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat', 'chat', false, 52428800)
on conflict (id) do nothing;

create policy "members view chat files" on storage.objects
  for select using (bucket_id = 'chat' and public.is_approved());
create policy "members upload chat files" on storage.objects
  for insert with check (
    bucket_id = 'chat' and public.is_approved()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "delete own chat files, admin any" on storage.objects
  for delete using (
    bucket_id = 'chat'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------------------------------------------------------------------
-- 9. Security hardening (November 2026 audit)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. Privileges: only what the website actually uses.
-- ---------------------------------------------------------------------
-- Logged-out visitors only ever read the site name and welcome line.
revoke all on public.persons, public.profiles, public.messages, public.site_settings from anon;
grant select (id, title_en, title_ne, tagline_en, tagline_ne) on public.site_settings to anon;

-- Signed-in users: drop the defaults nothing uses (TRUNCATE bypasses row rules).
revoke truncate, references, trigger on public.persons, public.profiles, public.messages, public.site_settings from authenticated;
revoke insert on public.profiles from authenticated;           -- profiles are created by the sign-up trigger
revoke update on public.messages from authenticated;           -- messages can't be edited
revoke insert, delete on public.site_settings from authenticated;

-- Helper checks: signed-in users only.
revoke execute on function public.is_approved(), public.is_admin(), public.can_edit_all(),
  public.can_contribute(), public.has_role(text[]) from public, anon;
grant execute on function public.is_approved(), public.is_admin(), public.can_edit_all(),
  public.can_contribute(), public.has_role(text[]) to authenticated;

-- ---------------------------------------------------------------------
-- 2. "This is me" requests, and the guard that protects links and authors.
-- ---------------------------------------------------------------------
alter table public.persons
  add column claim_requested_by uuid references auth.users (id) on delete set null;

create or replace function public.persons_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Changes made by the approved functions below (claims) skip the checks.
  if current_setting('family.trusted', true) = 'on' then
    new.updated_at := now();
    return new;
  end if;
  if not public.is_admin() then
    if tg_op = 'INSERT' then
      if new.user_id is not null and new.user_id <> auth.uid() then
        raise exception 'You can only link a person to your own account';
      end if;
      new.created_by := auth.uid();
      new.claim_requested_by := null;
    else
      new.created_by := old.created_by;
      new.claim_requested_by := old.claim_requested_by;
      if new.user_id is distinct from old.user_id then
        if old.user_id is not null and old.user_id <> auth.uid() then
          raise exception 'This person is linked to another member';
        end if;
        if new.user_id is not null and new.user_id <> auth.uid() then
          raise exception 'You can only link a person to your own account';
        end if;
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Link straight away if you're an admin or added that entry yourself; otherwise ask an admin.
-- Returns 'linked' or 'requested'.
drop function if exists public.claim_person(uuid);
create function public.claim_person(target uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.persons;
begin
  if not public.can_contribute() then
    raise exception 'Your account cannot add to the tree';
  end if;
  if exists (select 1 from public.persons where user_id = auth.uid()) then
    raise exception 'Your account is already linked to someone in the tree';
  end if;
  select * into p from public.persons where id = target for update;
  if not found or p.user_id is not null then
    raise exception 'This person is already linked to another member';
  end if;
  perform set_config('family.trusted', 'on', true);
  if public.is_admin() or p.created_by = auth.uid() then
    update public.persons set user_id = auth.uid(), claim_requested_by = null where id = target;
    return 'linked';
  end if;
  update public.persons set claim_requested_by = auth.uid() where id = target;
  return 'requested';
end;
$$;

create or replace function public.review_claim(target uuid, approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  requester uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can approve this';
  end if;
  select claim_requested_by into requester from public.persons where id = target for update;
  if requester is null then
    raise exception 'There is no request for this person';
  end if;
  perform set_config('family.trusted', 'on', true);
  if approve then
    if exists (select 1 from public.persons where user_id = requester) then
      raise exception 'That member is already linked to someone else in the tree';
    end if;
    update public.persons set user_id = requester, claim_requested_by = null where id = target and user_id is null;
  else
    update public.persons set claim_requested_by = null where id = target;
  end if;
end;
$$;

revoke execute on function public.claim_person(uuid), public.review_claim(uuid, boolean) from public, anon;
grant execute on function public.claim_person(uuid), public.review_claim(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Contact details (phone, email, address): only the person themselves,
--    whoever added them, editors and admins can read them.
-- ---------------------------------------------------------------------
revoke select on public.persons from authenticated;
grant select (id, parent_id, other_parent_id, spouse_of, full_name, gender, birth_date, is_living,
  death_date, birth_place, occupation, spouse_name, bio, photo_path, user_id, created_by,
  created_at, updated_at, claim_requested_by) on public.persons to authenticated;

create or replace function public.person_contact(target uuid)
returns table (phone text, email text, current_address text)
language sql
stable
security definer
set search_path = public
as $$
  select p.phone, p.email, p.current_address
  from public.persons p
  where p.id = target
    and public.is_approved()
    and (public.can_edit_all() or p.user_id = auth.uid() or p.created_by = auth.uid());
$$;
revoke execute on function public.person_contact(uuid) from public, anon;
grant execute on function public.person_contact(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Only editors and admins make new top ancestors, by adding or by editing.
-- ---------------------------------------------------------------------
drop policy "edit entries" on public.persons;
create policy "edit entries" on public.persons
  for update
  using (public.can_edit_all() or (public.can_contribute() and (created_by = auth.uid() or user_id = auth.uid())))
  with check (
    public.can_contribute()
    and (parent_id is not null or spouse_of is not null or public.can_edit_all()
         or exists (select 1 from public.persons o where o.id = persons.id and o.parent_id is null and o.spouse_of is null))
  );

-- ---------------------------------------------------------------------
-- 5. Chat limits.
-- ---------------------------------------------------------------------
-- Only everyday file types (no web pages, scripts or programs).
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/3gpp',
  'application/pdf', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]
where id = 'chat';

-- Room left for chat files: 200 MB per person and 700 MB in total (the free plan has 1 GB for everything).
create or replace function public.chat_upload_allowed()
returns boolean
language sql
stable
security definer
set search_path = public, storage
as $$
  select
    coalesce((select sum((metadata ->> 'size')::bigint) from storage.objects
              where bucket_id = 'chat' and (storage.foldername(name))[1] = auth.uid()::text), 0) < 200 * 1048576
    and coalesce((select sum((metadata ->> 'size')::bigint) from storage.objects where bucket_id = 'chat'), 0) < 700 * 1048576;
$$;
revoke execute on function public.chat_upload_allowed() from public, anon;
grant execute on function public.chat_upload_allowed() to authenticated;

drop policy "members upload chat files" on storage.objects;
create policy "members upload chat files" on storage.objects
  for insert with check (
    bucket_id = 'chat' and public.is_approved()
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.chat_upload_allowed()
  );

-- At most 20 messages a minute per person.
create or replace function public.messages_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.messages
      where sender_id = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'You are sending messages too fast. Please wait a minute.';
  end if;
  new.sender_id := auth.uid();
  new.sender_name := coalesce((select full_name from public.profiles where id = auth.uid()), '');
  new.created_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Backup export for admins, and an all-or-nothing "Connect me".
-- ---------------------------------------------------------------------
create or replace function public.admin_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, storage
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can download a backup';
  end if;
  return jsonb_build_object(
    'format', 'tuladhar-family-tree-backup-v1',
    'exported_at', now(),
    'site_settings', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.site_settings s),
    'persons', (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at), '[]'::jsonb) from public.persons p),
    'profiles', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) from public.profiles x),
    'messages', (select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at), '[]'::jsonb) from public.messages m),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'path', o.name,
                'size', o.metadata ->> 'size', 'type', o.metadata ->> 'mimetype', 'created_at', o.created_at)
                order by o.created_at), '[]'::jsonb)
              from storage.objects o where o.bucket_id in ('photos', 'chat'))
  );
end;
$$;
revoke execute on function public.admin_export() from public, anon;
grant execute on function public.admin_export() to authenticated;

-- Adds the missing ancestors (farthest first) and you in one go: if any step fails, nothing is saved.
-- Runs with the caller's own permissions, so all the normal rules apply.
create or replace function public.connect_me(anchor uuid, anchor_other uuid, ancestors jsonb, me jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  parent uuid := anchor;
  other uuid := anchor_other;
  a jsonb;
  new_id uuid;
begin
  for a in select value from jsonb_array_elements(coalesce(ancestors, '[]'::jsonb)) loop
    insert into public.persons (parent_id, other_parent_id, full_name, gender, birth_date, is_living, created_by)
    values (parent, other, a ->> 'full_name', nullif(a ->> 'gender', ''), nullif(a ->> 'birth_date', '')::date,
            coalesce((a ->> 'is_living')::boolean, true), auth.uid())
    returning id into parent;
    other := null;
  end loop;
  insert into public.persons (parent_id, other_parent_id, full_name, gender, birth_date, birth_place,
                              current_address, photo_path, is_living, user_id, created_by)
  values (parent, other, me ->> 'full_name', nullif(me ->> 'gender', ''), nullif(me ->> 'birth_date', '')::date,
          nullif(me ->> 'birth_place', ''), nullif(me ->> 'current_address', ''), nullif(me ->> 'photo_path', ''),
          true, auth.uid(), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;
revoke execute on function public.connect_me(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.connect_me(uuid, uuid, jsonb, jsonb) to authenticated;
