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
  is_admin    boolean not null default false,
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

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved' and is_admin
  );
$$;

-- ---------------------------------------------------------------------
-- 2. People in the family tree
-- ---------------------------------------------------------------------
create table public.persons (
  id              uuid primary key default gen_random_uuid(),
  parent_id       uuid references public.persons (id) on delete restrict,
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
  constraint not_own_parent check (parent_id is null or parent_id <> id)
);

create index persons_parent_idx on public.persons (parent_id);
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
grant execute on function public.is_approved(), public.is_admin() to authenticated;

-- Members see their own account; admins see everyone's.
create policy "read own profile, admin reads all" on public.profiles
  for select using (id = auth.uid() or public.is_admin());
-- Only admins approve, reject or promote members.
create policy "admin updates profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());
create policy "admin deletes profiles" on public.profiles
  for delete using (public.is_admin());

-- Only approved members can see the tree.
create policy "approved members read tree" on public.persons
  for select using (public.is_approved());
-- Approved members can add people.
create policy "approved members add people" on public.persons
  for insert with check (public.is_approved());
-- People can be edited by the member who added them, the member they belong to, or an admin.
create policy "edit own entries" on public.persons
  for update
  using (public.is_approved() and (public.is_admin() or created_by = auth.uid() or user_id = auth.uid()))
  with check (public.is_approved());
-- Only admins delete people.
create policy "admin deletes people" on public.persons
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------
-- 4. Photo storage (private: only approved members can view)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "approved members view photos" on storage.objects
  for select using (bucket_id = 'photos' and public.is_approved());
create policy "approved members upload own photos" on storage.objects
  for insert with check (
    bucket_id = 'photos' and public.is_approved()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "members update own photos" on storage.objects
  for update using (
    bucket_id = 'photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );
create policy "members delete own photos" on storage.objects
  for delete using (
    bucket_id = 'photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
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
  if not public.is_approved() then
    raise exception 'Your account is not approved yet';
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
