-- =====================================================================
-- Update: replace the admin yes/no flag with roles (admin, editor, member, viewer).
-- Only for databases created before roles existed. New projects just run
-- supabase-schema.sql, which already includes this.
-- =====================================================================

begin;

-- 1. Role column; existing admins become role 'admin'.
alter table public.profiles
  add column role text not null default 'member'
  check (role in ('admin', 'editor', 'member', 'viewer'));
update public.profiles set role = 'admin' where is_admin;

-- 2. Role checks.
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

grant execute on function public.can_edit_all(), public.can_contribute(), public.has_role(text[]) to authenticated;

alter table public.profiles drop column is_admin;

-- 3. Never let the last admin be demoted or removed.
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

-- 4. Tree rules by role.
drop policy "approved members add people" on public.persons;
drop policy "edit own entries" on public.persons;
drop policy "admin deletes people" on public.persons;

create policy "contributors add people" on public.persons
  for insert with check (public.can_contribute() and (parent_id is not null or public.can_edit_all()));
create policy "edit entries" on public.persons
  for update
  using (public.can_edit_all() or (public.can_contribute() and (created_by = auth.uid() or user_id = auth.uid())))
  with check (public.can_contribute());
create policy "editors delete people" on public.persons
  for delete using (public.can_edit_all());

-- 5. Photo rules by role.
drop policy "approved members upload own photos" on storage.objects;
drop policy "members update own photos" on storage.objects;
drop policy "members delete own photos" on storage.objects;

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

-- 6. Viewers can't link themselves to an entry.
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

commit;
