-- =====================================================================
-- Update: spouses as their own people, and each child's other parent.
-- Only for databases created before spouses were added. New projects just
-- run supabase-schema.sql, which already includes this.
-- =====================================================================

begin;

-- A spouse is a person who married into the family: spouse_of points to their
-- partner in the family line, and they have no parent_id of their own.
-- A child's parent_id is the parent in the family line; other_parent_id is
-- the spouse who is their other parent (mother or father).
alter table public.persons
  add column spouse_of uuid references public.persons (id) on delete cascade,
  add column other_parent_id uuid references public.persons (id) on delete set null,
  add constraint spouse_not_in_line check (spouse_of is null or parent_id is null),
  add constraint not_own_spouse check (spouse_of is null or spouse_of <> id);

create index persons_spouse_idx on public.persons (spouse_of);

-- Turn spouse names typed so far into spouse records.
insert into public.persons (full_name, spouse_of, gender, created_by)
select trim(spouse_name), id,
       case gender when 'male' then 'female' when 'female' then 'male' end,
       created_by
from public.persons
where coalesce(trim(spouse_name), '') <> '';

-- Children of someone with exactly one spouse get that spouse as their other parent.
update public.persons c
set other_parent_id = s.id
from public.persons s
where s.spouse_of = c.parent_id
  and c.other_parent_id is null
  and (select count(*) from public.persons x where x.spouse_of = c.parent_id) = 1;

update public.persons set spouse_name = null where spouse_name is not null;

-- Adding a spouse doesn't need a parent, like adding a child does.
drop policy "contributors add people" on public.persons;
create policy "contributors add people" on public.persons
  for insert with check (
    public.can_contribute()
    and (parent_id is not null or spouse_of is not null or public.can_edit_all())
  );

commit;
