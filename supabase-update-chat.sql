-- =====================================================================
-- Update: family group chat (text, photos, short videos, audio, files).
-- Only for databases created before the chat existed. New projects just run
-- supabase-schema.sql, which already includes it.
-- =====================================================================

begin;

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

commit;
