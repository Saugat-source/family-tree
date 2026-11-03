-- =====================================================================
-- Update: security hardening from the November 2026 audit.
--   * remove privileges the site never needs (audit M4, L2)
--   * hide phone, email and address from other members (M8)
--   * "This is me" needs an admin's approval unless you added that entry (M6)
--   * members can't turn their entries into new top ancestors (L1)
--   * chat: allowed file types, per-person storage limit, posting speed limit (M5, M7, L8)
--   * admin backup export, and an all-or-nothing "Connect me" (H2, L5)
-- Only for databases created before this update. New projects just run
-- supabase-schema.sql, which already includes it.
-- =====================================================================

begin;

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

commit;
