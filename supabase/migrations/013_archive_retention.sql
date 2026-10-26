-- Apply after 012. Adds month-level archive/retention metadata without moving
-- or deleting historical business records. Permanent deletion is intentionally
-- left to an authenticated production scheduler after the grace period.
begin;

alter table public.organizations
 add column archive_retention_months integer default 24
 check(archive_retention_months is null or archive_retention_months in (12,24,36,60));
update public.organizations set archive_retention_months=24 where archive_retention_months is null;

create table public.archive_months (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 month_start date not null check(month_start=date_trunc('month',month_start)::date),
 state text not null default 'archived' check(state in ('archived','scheduled_deletion')),
 deletion_scheduled_at timestamptz,
 grace_until timestamptz,
 retention_hold_until date,
 exceptional_edit_until timestamptz,
 exceptional_edit_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(organization_id,month_start)
);
create index archive_months_state_idx on public.archive_months(organization_id,state,month_start);

create table public.archive_events (
 id bigint generated always as identity primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 month_start date,
 actor_user_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('exceptional_edit_started','exceptional_edit_ended','retention_changed','deletion_cancelled','backup_created')),
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index archive_events_tenant_idx on public.archive_events(organization_id,created_at desc);

alter table public.archive_months enable row level security;
alter table public.archive_events enable row level security;
revoke all on public.archive_months,public.archive_events from public,anon,authenticated;
grant select on public.archive_months to authenticated;
create policy archive_months_tenant_read on public.archive_months for select to authenticated
 using(organization_id=(select public.current_organization_id()));

create function planner_private.archive_month_allowed(p_date date) returns boolean
language sql stable security definer set search_path='' as $$
 select p_date is null or p_date>=date_trunc('month',current_date)::date or exists(
  select 1 from public.archive_months m join public.profiles p
   on p.user_id=auth.uid() and p.organization_id=m.organization_id and p.is_active and p.role='admin'
  where m.organization_id=public.current_organization_id()
   and m.month_start=date_trunc('month',p_date)::date
   and m.exceptional_edit_until>now()
 )
$$;

create function planner_private.guard_archived_date() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_date date; new_date date;
begin
 if tg_table_name='attendance_variations' then
  if tg_op<>'INSERT' then select date into old_date from public.shifts where organization_id=old.organization_id and id=old.shift_id; end if;
  if tg_op<>'DELETE' then select date into new_date from public.shifts where organization_id=new.organization_id and id=new.shift_id; end if;
 elsif tg_table_name='requests' then
  if tg_op<>'INSERT' and (not planner_private.archive_month_allowed(old.start_date) or not planner_private.archive_month_allowed(old.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  if tg_op<>'DELETE' and (not planner_private.archive_month_allowed(new.start_date) or not planner_private.archive_month_allowed(new.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  return case when tg_op='DELETE' then old else new end;
 else
  if tg_op<>'INSERT' then old_date:=old.date; end if;
  if tg_op<>'DELETE' then new_date:=new.date; end if;
 end if;
 if not planner_private.archive_month_allowed(old_date) or not planner_private.archive_month_allowed(new_date) then
  -- Full snapshot saves UPSERT every row. Keep a locked historical row byte-for-byte
  -- unchanged; inserts, deletes and request workflow changes remain hard failures.
  if tg_op='INSERT' and tg_table_name='shifts' and exists(select 1 from public.shifts where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='attendance_variations' and exists(select 1 from public.attendance_variations where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='notes' and exists(select 1 from public.notes where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='UPDATE' and tg_table_name in ('shifts','attendance_variations','notes') then return old; end if;
  raise exception 'Archived month is read only' using errcode='42501';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;

create trigger shifts_archive_guard before insert or update or delete on public.shifts
 for each row execute function planner_private.guard_archived_date();
create trigger variations_archive_guard before insert or update or delete on public.attendance_variations
 for each row execute function planner_private.guard_archived_date();
create trigger notes_archive_guard before insert or update or delete on public.notes
 for each row execute function planner_private.guard_archived_date();
create trigger requests_archive_guard before insert or update or delete on public.requests
 for each row execute function planner_private.guard_archived_date();

create function planner_private.refresh_archive(p_oid uuid) returns void
language plpgsql security definer set search_path='' as $$
declare retention integer;
begin
 insert into public.archive_months(organization_id,month_start)
 select p_oid,month_start from (
  select date_trunc('month',date)::date month_start from public.shifts where organization_id=p_oid
  union select date_trunc('month',date)::date from public.notes where organization_id=p_oid and date is not null
  union select month_start::date from public.requests r cross join lateral generate_series(date_trunc('month',r.start_date),date_trunc('month',r.end_date),interval '1 month') month_start where r.organization_id=p_oid
 ) months where month_start<date_trunc('month',current_date)::date
 on conflict do nothing;
 select archive_retention_months into retention from public.organizations where id=p_oid;
 if retention is not null then
  update public.archive_months m set
   state='scheduled_deletion',
   deletion_scheduled_at=coalesce(m.deletion_scheduled_at,now()),
   grace_until=coalesce(m.grace_until,now()+interval '30 days'),
   updated_at=now()
  where m.organization_id=p_oid and m.state='archived'
   and current_date>=greatest((m.month_start+interval '1 month'+make_interval(months=>retention))::date,coalesce(m.retention_hold_until,'-infinity'::date));
 end if;
end $$;

create function public.archive_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.profiles; retention integer; result jsonb;
begin
 member:=planner_private.lock_member(p_organization_id);
 perform planner_private.refresh_archive(p_organization_id);
 select archive_retention_months into retention from public.organizations where id=p_organization_id;
 select jsonb_build_object(
  'organization_id',p_organization_id,'retention_months',retention,
  'months',coalesce(jsonb_agg(jsonb_build_object(
   'month_start',m.month_start,'state',m.state,
   'warning_at',case when retention is null then null else greatest((m.month_start+interval '1 month'+make_interval(months=>retention)-interval '30 days')::date,coalesce(m.retention_hold_until,'-infinity'::date)-30) end,
   'deletion_scheduled_at',m.deletion_scheduled_at,'grace_until',m.grace_until,
   'approaching_deletion',retention is not null and m.state='archived' and current_date>=greatest((m.month_start+interval '1 month'+make_interval(months=>retention)-interval '30 days')::date,coalesce(m.retention_hold_until,'-infinity'::date)-30),
   'exceptional_edit_until',case when member.role='admin' then m.exceptional_edit_until else null end
  ) order by m.month_start desc),'[]'::jsonb)) into result
 from public.archive_months m
 where m.organization_id=p_organization_id
  and m.month_start<date_trunc('month',current_date)::date;
 return result;
end $$;

create function public.archive_retention_update(p_organization_id uuid,p_months integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_months is not null and p_months not in (12,24,36,60) then raise exception 'Invalid retention'; end if;
 update public.organizations set archive_retention_months=p_months,updated_at=now() where id=p_organization_id;
 insert into public.archive_events(organization_id,actor_user_id,action,details)
 values(p_organization_id,auth.uid(),'retention_changed',jsonb_build_object('months',p_months));
 return public.archive_list(p_organization_id);
end $$;

create function public.archive_exceptional_edit_begin(p_organization_id uuid,p_month_start date,p_confirmation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.archive_months;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_month_start<>date_trunc('month',p_month_start)::date or p_month_start>=date_trunc('month',current_date)::date
  or p_confirmation is distinct from 'MODIFICA ECCEZIONALE' then raise exception 'Invalid exceptional edit confirmation'; end if;
 perform planner_private.refresh_archive(p_organization_id);
 update public.archive_months set exceptional_edit_until=now()+interval '30 minutes',exceptional_edit_by=auth.uid(),updated_at=now()
 where organization_id=p_organization_id and month_start=p_month_start and state='archived' returning * into result;
 if not found then raise exception 'Archived month unavailable'; end if;
 insert into public.archive_events(organization_id,month_start,actor_user_id,action,details)
 values(p_organization_id,p_month_start,auth.uid(),'exceptional_edit_started',jsonb_build_object('until',result.exceptional_edit_until));
 return to_jsonb(result);
end $$;

create function public.archive_exceptional_edit_end(p_organization_id uuid,p_month_start date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.archive_months;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 update public.archive_months set exceptional_edit_until=null,exceptional_edit_by=null,updated_at=now()
 where organization_id=p_organization_id and month_start=p_month_start returning * into result;
 insert into public.archive_events(organization_id,month_start,actor_user_id,action)
 values(p_organization_id,p_month_start,auth.uid(),'exceptional_edit_ended');
 return to_jsonb(result);
end $$;

create function public.archive_deletion_cancel(p_organization_id uuid,p_month_start date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.archive_months;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 update public.archive_months set state='archived',deletion_scheduled_at=null,grace_until=null,
  retention_hold_until=current_date+60,updated_at=now()
 where organization_id=p_organization_id and month_start=p_month_start returning * into result;
 if not found then raise exception 'Archived month unavailable'; end if;
 insert into public.archive_events(organization_id,month_start,actor_user_id,action,details)
 values(p_organization_id,p_month_start,auth.uid(),'deletion_cancelled',jsonb_build_object('hold_until',result.retention_hold_until));
 return to_jsonb(result);
end $$;

create function public.archive_backup_record(p_organization_id uuid,p_scope text,p_month_start date default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare event_row public.archive_events;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_scope not in ('month','year','all') or (p_scope in ('month','year') and p_month_start is null) then raise exception 'Invalid backup scope'; end if;
 insert into public.archive_events(organization_id,month_start,actor_user_id,action,details)
 values(p_organization_id,p_month_start,auth.uid(),'backup_created',jsonb_build_object('scope',p_scope)) returning * into event_row;
 return jsonb_build_object('organization_id',p_organization_id,'scope',p_scope,'month_start',p_month_start,'created_at',event_row.created_at);
end $$;

revoke all on function public.archive_list(uuid),public.archive_retention_update(uuid,integer),
 public.archive_exceptional_edit_begin(uuid,date,text),public.archive_exceptional_edit_end(uuid,date),
 public.archive_deletion_cancel(uuid,date),public.archive_backup_record(uuid,text,date) from public,anon;
grant execute on function public.archive_list(uuid),public.archive_retention_update(uuid,integer),
 public.archive_exceptional_edit_begin(uuid,date,text),public.archive_exceptional_edit_end(uuid,date),
 public.archive_deletion_cancel(uuid,date),public.archive_backup_record(uuid,text,date) to authenticated;

revoke all on function planner_private.archive_month_allowed(date),planner_private.guard_archived_date(),planner_private.refresh_archive(uuid) from public,anon,authenticated;
commit;
