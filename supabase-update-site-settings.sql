-- =====================================================================
-- Update: site name and welcome line stored in the database, so admins can
-- change them on the Members & roles page without editing code.
-- Only for databases created before this existed. New projects just run
-- supabase-schema.sql, which already includes it.
-- =====================================================================

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

insert into public.site_settings (id, title_en, title_ne)
values (1, 'Tuladhar Family Tree', 'तुलाधर परिवारको वंशवृक्ष')
on conflict (id) do nothing;
