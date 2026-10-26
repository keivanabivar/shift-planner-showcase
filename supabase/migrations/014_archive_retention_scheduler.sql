-- Apply once after 013_archive_retention.sql. Adds the private, atomic retention
-- processor used by Supabase Cron. Cron configuration itself is intentionally a
-- dashboard/production step so local development never depends on a scheduler.
begin;

do $$ begin
 if to_regclass('public.archive_months') is null
 or to_regprocedure('planner_private.refresh_archive(uuid)') is null then
  raise exception '014 requires migrations 001 through 013';
 end if;
 if to_regclass('public.archive_retention_log') is not null then
  raise exception '014 already applied, or public.archive_retention_log exists: inspect before proceeding';
 end if;
end $$;

alter table public.archive_months drop constraint archive_months_state_check;
alter table public.archive_months add constraint archive_months_state_check
 check(state in ('archived','scheduled_deletion','permanently_deleted'));

create table public.archive_retention_log (
 id bigint generated always as identity primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 month_start date not null check(month_start=date_trunc('month',month_start)::date),
 status text not null check(status in ('succeeded','failed')),
 job_source text not null check(length(job_source) between 1 and 100),
 processed_at timestamptz not null default clock_timestamp(),
 deleted_counts jsonb not null default '{}'::jsonb,
 error_code text,
 error_message text,
 check(
  (status='succeeded' and error_code is null and error_message is null)
  or (status='failed' and error_code is not null and error_message is not null)
 )
);
create unique index archive_retention_log_success_once
 on public.archive_retention_log(organization_id,month_start) where status='succeeded';
create index archive_retention_log_recent
 on public.archive_retention_log(processed_at desc,organization_id);
alter table public.archive_retention_log enable row level security;
revoke all on public.archive_retention_log from public,anon,authenticated;

-- This helper is deliberately limited to a postgres-owned scheduler session and
-- the exact tenant/month selected by the private processor. Browser RPC sessions
-- use the authenticator session role and cannot forge this bypass.
create function planner_private.retention_delete_allowed(p_oid uuid,p_date date) returns boolean
language sql stable security definer set search_path='' as $$
 select session_user='postgres'
  and current_setting('planner.retention_organization_id',true)=p_oid::text
  and current_setting('planner.retention_month_start',true)=date_trunc('month',p_date)::date::text
$$;

create or replace function planner_private.guard_archived_date() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_date date; new_date date; oid uuid;
begin
 oid:=case when tg_op='DELETE' then old.organization_id else new.organization_id end;
 if tg_table_name='attendance_variations' then
  if tg_op<>'INSERT' then select date into old_date from public.shifts where organization_id=old.organization_id and id=old.shift_id; end if;
  if tg_op<>'DELETE' then select date into new_date from public.shifts where organization_id=new.organization_id and id=new.shift_id; end if;
 elsif tg_table_name='requests' then
  if tg_op<>'INSERT' and not planner_private.retention_delete_allowed(old.organization_id,old.start_date)
   and (not planner_private.archive_month_allowed(old.start_date) or not planner_private.archive_month_allowed(old.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  if tg_op<>'DELETE' and not planner_private.retention_delete_allowed(new.organization_id,new.start_date)
   and (not planner_private.archive_month_allowed(new.start_date) or not planner_private.archive_month_allowed(new.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  return case when tg_op='DELETE' then old else new end;
 else
  if tg_op<>'INSERT' then old_date:=old.date; end if;
  if tg_op<>'DELETE' then new_date:=new.date; end if;
 end if;
 if (old_date is not null and planner_private.retention_delete_allowed(oid,old_date))
 or (new_date is not null and planner_private.retention_delete_allowed(oid,new_date)) then
  return case when tg_op='DELETE' then old else new end;
 end if;
 if not planner_private.archive_month_allowed(old_date) or not planner_private.archive_month_allowed(new_date) then
  if tg_op='INSERT' and tg_table_name='shifts' and exists(select 1 from public.shifts where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='attendance_variations' and exists(select 1 from public.attendance_variations where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='notes' and exists(select 1 from public.notes where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='UPDATE' and tg_table_name in ('shifts','attendance_variations','notes') then return old; end if;
  raise exception 'Archived month is read only' using errcode='42501';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;

create or replace function public.archive_list(p_organization_id uuid) returns jsonb
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
  and m.state<>'permanently_deleted'
  and m.month_start<date_trunc('month',current_date)::date;
 return result;
end $$;

-- A stale browser request must not resurrect a marker after the backend has
-- permanently deleted it. Cancellation is valid only while still scheduled.
create or replace function public.archive_deletion_cancel(p_organization_id uuid,p_month_start date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.archive_months;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 update public.archive_months set state='archived',deletion_scheduled_at=null,grace_until=null,
  retention_hold_until=current_date+60,updated_at=now()
 where organization_id=p_organization_id and month_start=p_month_start and state='scheduled_deletion'
 returning * into result;
 if not found then raise exception 'Scheduled archive month unavailable'; end if;
 insert into public.archive_events(organization_id,month_start,actor_user_id,action,details)
 values(p_organization_id,p_month_start,auth.uid(),'deletion_cancelled',jsonb_build_object('hold_until',result.retention_hold_until));
 return to_jsonb(result);
end $$;

-- Each loop body is a PL/pgSQL subtransaction. A failure rolls back every
-- deletion and state change for that month, then writes one diagnostic row.
create function planner_private.process_archive_retention(
 p_job_source text default 'supabase-cron',
 p_organization_id uuid default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record; locked_month public.archive_months; counts jsonb; successes integer:=0; failures integer:=0;
 err_code text; err_message text; month_end date;
begin
 if session_user<>'postgres' then raise exception 'Retention processor is backend-only' using errcode='42501'; end if;
 if p_job_source is null or length(trim(p_job_source)) not between 1 and 100 then raise exception 'Invalid job source'; end if;
 for candidate in
  select m.organization_id,m.month_start
  from public.archive_months m join public.organizations o on o.id=m.organization_id
  where m.state='scheduled_deletion' and m.grace_until<=clock_timestamp()
   and m.month_start<date_trunc('month',current_date)::date
   and o.archive_retention_months is not null
   and current_date>=(m.month_start+interval '1 month'+make_interval(months=>o.archive_retention_months))::date
   and current_date>=coalesce(m.retention_hold_until,'-infinity'::date)
   and (p_organization_id is null or m.organization_id=p_organization_id)
  order by m.organization_id,m.month_start
 loop
  begin
   perform 1 from public.planner_state where organization_id=candidate.organization_id and id=true for update;
   select m.* into locked_month from public.archive_months m join public.organizations o on o.id=m.organization_id
    where m.organization_id=candidate.organization_id and m.month_start=candidate.month_start
     and m.state='scheduled_deletion' and m.grace_until<=clock_timestamp()
     and m.month_start<date_trunc('month',current_date)::date
     and o.archive_retention_months is not null
     and current_date>=(m.month_start+interval '1 month'+make_interval(months=>o.archive_retention_months))::date
     and current_date>=coalesce(m.retention_hold_until,'-infinity'::date)
    for update of m;
   if not found then continue; end if;
   month_end:=(locked_month.month_start+interval '1 month')::date;
   perform set_config('planner.retention_organization_id',locked_month.organization_id::text,true);
   perform set_config('planner.retention_month_start',locked_month.month_start::text,true);

   with removed as (
    delete from public.attendance_variations v using public.shifts s
    where v.organization_id=locked_month.organization_id and s.organization_id=v.organization_id
     and s.id=v.shift_id and s.date>=locked_month.month_start and s.date<month_end returning 1
   ) select jsonb_build_object('attendance_variations',count(*)) into counts from removed;
   with removed as (
    delete from public.request_shift_changes
    where organization_id=locked_month.organization_id and shift_date>=locked_month.month_start and shift_date<month_end returning 1
   ) select counts||jsonb_build_object('request_shift_changes',count(*)) into counts from removed;
   with removed as (
    delete from public.shifts where organization_id=locked_month.organization_id
     and date>=locked_month.month_start and date<month_end returning 1
   ) select counts||jsonb_build_object('shifts',count(*)) into counts from removed;
   with scoped_requests as (
    select id from public.requests where organization_id=locked_month.organization_id
     and start_date>=locked_month.month_start and end_date<month_end
     and (approved_start_date is null or (approved_start_date>=locked_month.month_start and approved_end_date<month_end))
   ), removed as (
    delete from public.request_events e using scoped_requests r
    where e.organization_id=locked_month.organization_id and e.request_id=r.id returning 1
   ) select counts||jsonb_build_object('request_events',count(*)) into counts from removed;
   with scoped_requests as (
    select id from public.requests where organization_id=locked_month.organization_id
     and start_date>=locked_month.month_start and end_date<month_end
     and (approved_start_date is null or (approved_start_date>=locked_month.month_start and approved_end_date<month_end))
   ), removed as (
    delete from public.request_shift_changes c using scoped_requests r
    where c.organization_id=locked_month.organization_id and c.request_id=r.id returning 1
   ) select counts||jsonb_build_object('request_shift_changes',coalesce((counts->>'request_shift_changes')::bigint,0)+count(*)) into counts from removed;
   with removed as (
    delete from public.requests where organization_id=locked_month.organization_id
     and start_date>=locked_month.month_start and end_date<month_end
     and (approved_start_date is null or (approved_start_date>=locked_month.month_start and approved_end_date<month_end)) returning 1
   ) select counts||jsonb_build_object('requests',count(*)) into counts from removed;
   with removed as (
    delete from public.notes where organization_id=locked_month.organization_id
     and date>=locked_month.month_start and date<month_end returning 1
   ) select counts||jsonb_build_object('notes',count(*)) into counts from removed;

   update public.archive_months set state='permanently_deleted',exceptional_edit_until=null,
    exceptional_edit_by=null,updated_at=clock_timestamp()
   where organization_id=locked_month.organization_id and month_start=locked_month.month_start;
   perform planner_private.bump_revision(locked_month.organization_id);
   insert into public.archive_retention_log(organization_id,month_start,status,job_source,deleted_counts)
    values(locked_month.organization_id,locked_month.month_start,'succeeded',trim(p_job_source),counts);
   successes:=successes+1;
  exception when others then
   get stacked diagnostics err_code=returned_sqlstate,err_message=message_text;
   insert into public.archive_retention_log(organization_id,month_start,status,job_source,error_code,error_message)
    values(candidate.organization_id,candidate.month_start,'failed',trim(p_job_source),err_code,left(err_message,500));
   failures:=failures+1;
  end;
 end loop;
 return jsonb_build_object('succeeded',successes,'failed',failures);
end $$;

revoke all on function planner_private.retention_delete_allowed(uuid,date),
 planner_private.process_archive_retention(text,uuid) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
