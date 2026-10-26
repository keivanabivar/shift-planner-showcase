-- Per-user request outcome receipts and stable Note unread timestamps.
-- Apply once after 008_request_reversal_effective_templates_notes.sql.
begin;

do $$ begin
 if to_regclass('public.note_reads') is null or to_regprocedure('public.request_revoke(uuid,uuid,bigint,bigint,boolean,text)') is null then
  raise exception '009 requires migrations 001 through 008';
 end if;
end $$;

create table public.request_reads(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(organization_id,user_id)
);
alter table public.request_reads enable row level security;
revoke all on public.request_reads from public,anon,authenticated;

-- Existing outcomes and notes are the baseline when this migration is installed.
-- This prevents migration/default timestamps from appearing as new activity.
insert into public.request_reads(organization_id,user_id,read_at)
 select organization_id,user_id,clock_timestamp() from public.profiles where is_active
 on conflict(organization_id,user_id) do nothing;
insert into public.note_reads(organization_id,user_id,read_at)
 select organization_id,user_id,clock_timestamp() from public.profiles where is_active
 on conflict(organization_id,user_id) do update set read_at=greatest(public.note_reads.read_at,excluded.read_at);

create function planner_private.preserve_unchanged_note_timestamp() returns trigger
language plpgsql set search_path='' as $$
begin
 if (new.text,new.date,new.employee_id) is not distinct from (old.text,old.date,old.employee_id)
 and new.updated_by_user_id is not distinct from old.updated_by_user_id then
  new.updated_at:=old.updated_at;
 end if;
 return new;
end $$;
create trigger notes_preserve_unchanged_timestamp before update on public.notes
 for each row execute function planner_private.preserve_unchanged_note_timestamp();

create or replace function public.note_unread_state(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; last_read timestamptz;
begin
 m:=planner_private.lock_member(p_organization_id);
 select read_at into last_read from public.note_reads where organization_id=p_organization_id and user_id=m.user_id;
 return jsonb_build_object('organization_id',p_organization_id,'unread',exists(
  select 1 from public.notes n where n.organization_id=p_organization_id
  and n.updated_by_user_id is not null and n.updated_by_user_id<>m.user_id
  and n.updated_at>coalesce(last_read,'-infinity'::timestamptz)));
end $$;

create function public.request_unread_state(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; last_read timestamptz; ids jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select read_at into last_read from public.request_reads where organization_id=p_organization_id and user_id=m.user_id;
 select coalesce(jsonb_agg(r.id order by r.updated_at),'[]'::jsonb) into ids
 from public.requests r where r.organization_id=p_organization_id and r.created_by_user_id=m.user_id
 and r.status in ('approved','rejected','cancelled','revoked')
 and r.updated_at>coalesce(last_read,'-infinity'::timestamptz)
 and case r.status
  when 'approved' then r.decided_by_user_id is distinct from m.user_id
  when 'rejected' then r.decided_by_user_id is distinct from m.user_id
  when 'cancelled' then r.cancelled_by_user_id is distinct from m.user_id
  when 'revoked' then r.revoked_by_user_id is distinct from m.user_id
  else false end;
 return jsonb_build_object('organization_id',p_organization_id,'unread',jsonb_array_length(ids)>0,'request_ids',ids);
end $$;

create function public.request_mark_read(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; stamp timestamptz:=clock_timestamp();
begin
 m:=planner_private.lock_member(p_organization_id);
 insert into public.request_reads(organization_id,user_id,read_at) values(p_organization_id,m.user_id,stamp)
 on conflict(organization_id,user_id) do update set read_at=excluded.read_at;
 return jsonb_build_object('organization_id',p_organization_id,'read_at',stamp,'unread',false,'request_ids','[]'::jsonb);
end $$;

revoke all on function public.request_unread_state(uuid),public.request_mark_read(uuid) from public,anon,authenticated;
grant execute on function public.request_unread_state(uuid),public.request_mark_read(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
