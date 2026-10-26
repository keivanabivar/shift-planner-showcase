-- Apply once after 014_archive_retention_scheduler.sql. The beta keeps archive
-- months indefinitely and permits only an explicit, audited Admin deletion.
-- This migration neither schedules nor invokes the historical Cron processor.
begin;

-- Disable the historical retention state machine for every existing and future
-- organization. Keep the column and migrations 013/014 as historical schema.
alter table public.organizations alter column archive_retention_months set default null;
update public.organizations set archive_retention_months=null where archive_retention_months is not null;
update public.archive_months set state='archived',deletion_scheduled_at=null,grace_until=null,
 retention_hold_until=null,updated_at=clock_timestamp()
where state='scheduled_deletion';

alter table public.archive_events drop constraint archive_events_action_check;
alter table public.archive_events add constraint archive_events_action_check check(action in (
 'exceptional_edit_started','exceptional_edit_ended','retention_changed','deletion_cancelled',
 'backup_created','manual_archive_deleted'
));

-- A transaction-local capability row lets the archive guards distinguish this
-- RPC from ordinary authenticated DML. Authenticated users cannot access it.
create table planner_private.manual_archive_delete_context (
 transaction_id bigint primary key,
 organization_id uuid not null,
 month_start date not null,
 actor_user_id uuid not null
);
revoke all on planner_private.manual_archive_delete_context from public,anon,authenticated;

create or replace function planner_private.retention_delete_allowed(p_oid uuid,p_date date) returns boolean
language sql stable security definer set search_path='' as $$
 select (
  session_user='postgres'
  and current_setting('planner.retention_organization_id',true)=p_oid::text
  and current_setting('planner.retention_month_start',true)=date_trunc('month',p_date)::date::text
 ) or exists(
  select 1 from planner_private.manual_archive_delete_context c
  where c.transaction_id=txid_current() and c.organization_id=p_oid
   and c.month_start=date_trunc('month',p_date)::date and c.actor_user_id=auth.uid()
 )
$$;

-- Materialize completed months only. No age, countdown, grace period, or state
-- transition is part of normal beta behavior.
create or replace function planner_private.refresh_archive(p_oid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into public.archive_months(organization_id,month_start)
 select p_oid,month_start from (
  select date_trunc('month',date)::date month_start from public.shifts where organization_id=p_oid
  union select date_trunc('month',date)::date from public.notes where organization_id=p_oid and date is not null
  union select month_start::date from public.requests r cross join lateral
   generate_series(date_trunc('month',r.start_date),date_trunc('month',r.end_date),interval '1 month') month_start
   where r.organization_id=p_oid
 ) months where month_start<date_trunc('month',current_date)::date
 on conflict do nothing;
end $$;

create or replace function public.archive_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.profiles; result jsonb;
begin
 member:=planner_private.lock_member(p_organization_id);
 perform planner_private.refresh_archive(p_organization_id);
 select jsonb_build_object(
  'organization_id',p_organization_id,'retention_months',null,
  'months',coalesce(jsonb_agg(jsonb_build_object(
   'month_start',m.month_start,'state','archived','warning_at',null,
   'deletion_scheduled_at',null,'grace_until',null,'approaching_deletion',false,
   'exceptional_edit_until',case when member.role='admin' then m.exceptional_edit_until else null end
  ) order by m.month_start desc),'[]'::jsonb)
 ) into result
 from public.archive_months m
 where m.organization_id=p_organization_id and m.state<>'permanently_deleted'
  and m.month_start<date_trunc('month',current_date)::date;
 return result;
end $$;

create function public.archive_delete_manual(
 p_organization_id uuid,p_month_start date,p_confirmation text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare marker public.archive_months; month_end date; counts jsonb:='{}'::jsonb;
 expected text; actor uuid:=auth.uid();
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_month_start is null or p_month_start<>date_trunc('month',p_month_start)::date
  or p_month_start>=date_trunc('month',current_date)::date then
  raise exception 'Only completed archived months can be deleted' using errcode='22023';
 end if;
 expected:='ELIMINA '||(case extract(month from p_month_start)
  when 1 then 'GENNAIO' when 2 then 'FEBBRAIO' when 3 then 'MARZO' when 4 then 'APRILE'
  when 5 then 'MAGGIO' when 6 then 'GIUGNO' when 7 then 'LUGLIO' when 8 then 'AGOSTO'
  when 9 then 'SETTEMBRE' when 10 then 'OTTOBRE' when 11 then 'NOVEMBRE' else 'DICEMBRE' end)
  ||' '||extract(year from p_month_start)::integer;
 if p_confirmation is distinct from expected then
  raise exception 'Invalid archive deletion confirmation' using errcode='22023';
 end if;

 perform 1 from public.planner_state where organization_id=p_organization_id and id=true for update;
 perform planner_private.refresh_archive(p_organization_id);
 select * into marker from public.archive_months
 where organization_id=p_organization_id and month_start=p_month_start for update;
 if not found then raise exception 'Archived month unavailable'; end if;
 if marker.state='permanently_deleted' then
  return jsonb_build_object('organization_id',p_organization_id,'month_start',p_month_start,
   'status','already_deleted','deleted_counts','{}'::jsonb);
 end if;
 month_end:=(p_month_start+interval '1 month')::date;
 insert into planner_private.manual_archive_delete_context
  values(txid_current(),p_organization_id,p_month_start,actor);

 with removed as (delete from public.attendance_variations v using public.shifts s
  where v.organization_id=p_organization_id and s.organization_id=v.organization_id
   and s.id=v.shift_id and s.date>=p_month_start and s.date<month_end returning 1)
 select jsonb_build_object('attendance_variations',count(*)) into counts from removed;
 with removed as (delete from public.request_shift_changes
  where organization_id=p_organization_id and shift_date>=p_month_start and shift_date<month_end returning 1)
 select counts||jsonb_build_object('request_shift_changes',count(*)) into counts from removed;
 with removed as (delete from public.shifts where organization_id=p_organization_id
  and date>=p_month_start and date<month_end returning 1)
 select counts||jsonb_build_object('shifts',count(*)) into counts from removed;
 with scoped as (select id from public.requests where organization_id=p_organization_id
  and start_date>=p_month_start and end_date<month_end
  and (approved_start_date is null or (approved_start_date>=p_month_start and approved_end_date<month_end))),
 removed as (delete from public.request_events e using scoped r
  where e.organization_id=p_organization_id and e.request_id=r.id returning 1)
 select counts||jsonb_build_object('request_events',count(*)) into counts from removed;
 with scoped as (select id from public.requests where organization_id=p_organization_id
  and start_date>=p_month_start and end_date<month_end
  and (approved_start_date is null or (approved_start_date>=p_month_start and approved_end_date<month_end))),
 removed as (delete from public.request_shift_changes c using scoped r
  where c.organization_id=p_organization_id and c.request_id=r.id returning 1)
 select counts||jsonb_build_object('request_shift_changes',
  coalesce((counts->>'request_shift_changes')::bigint,0)+count(*)) into counts from removed;
 with removed as (delete from public.requests where organization_id=p_organization_id
  and start_date>=p_month_start and end_date<month_end
  and (approved_start_date is null or (approved_start_date>=p_month_start and approved_end_date<month_end)) returning 1)
 select counts||jsonb_build_object('requests',count(*)) into counts from removed;
 with removed as (delete from public.notes where organization_id=p_organization_id
  and date>=p_month_start and date<month_end returning 1)
 select counts||jsonb_build_object('notes',count(*)) into counts from removed;

 update public.archive_months set state='permanently_deleted',exceptional_edit_until=null,
  exceptional_edit_by=null,deletion_scheduled_at=null,grace_until=null,updated_at=clock_timestamp()
 where organization_id=p_organization_id and month_start=p_month_start;
 perform planner_private.bump_revision(p_organization_id);
 insert into public.archive_events(organization_id,month_start,actor_user_id,action,details)
 values(p_organization_id,p_month_start,actor,'manual_archive_deleted',
  jsonb_build_object('source','manual archive deletion','deleted_counts',counts));
 insert into public.archive_retention_log(organization_id,month_start,status,job_source,deleted_counts)
 values(p_organization_id,p_month_start,'succeeded','manual archive deletion',counts)
 on conflict (organization_id,month_start) where status='succeeded' do nothing;
 delete from planner_private.manual_archive_delete_context where transaction_id=txid_current();
 return jsonb_build_object('organization_id',p_organization_id,'month_start',p_month_start,
  'status','deleted','deleted_counts',counts);
end $$;

revoke all on function public.archive_delete_manual(uuid,date,text) from public,anon;
grant execute on function public.archive_delete_manual(uuid,date,text) to authenticated;
revoke all on function planner_private.retention_delete_allowed(uuid,date),
 planner_private.refresh_archive(uuid) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
