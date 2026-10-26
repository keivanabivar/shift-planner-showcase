-- Separate live branch blockers from retained history.
-- Apply once after 025. This migration is intentionally not applied automatically.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.branch_delete_empty(uuid,uuid,text)') is null
 or to_regclass('public.branch_access_events') is null then
  raise exception '026 requires migrations 017 through 025';
 end if;
end $$;

alter table public.requests add column approval_branch_name text;
update public.requests r set approval_branch_name=b.name from public.branches b
 where b.organization_id=r.organization_id and b.id=r.approval_branch_id;
alter table public.requests alter column approval_branch_id drop not null;
alter table public.requests drop constraint requests_approval_branch_fk;
alter table public.requests add constraint requests_approval_branch_fk
 foreign key(organization_id,approval_branch_id) references public.branches(organization_id,id) on delete restrict;

alter table public.cross_branch_shift_requests
 add column home_branch_name text,
 add column destination_branch_name text;
update public.cross_branch_shift_requests r set
 home_branch_name=h.name,destination_branch_name=d.name
from public.branches h,public.branches d
where h.organization_id=r.organization_id and h.id=r.home_branch_id
 and d.organization_id=r.organization_id and d.id=r.destination_branch_id;
alter table public.cross_branch_shift_requests alter column home_branch_id drop not null;
alter table public.cross_branch_shift_requests alter column destination_branch_id drop not null;
do $$ declare constraint_name text;
begin
 for constraint_name in
  select c.conname from pg_constraint c
  where c.conrelid='public.cross_branch_shift_requests'::regclass and c.contype='f'
   and c.confrelid='public.branches'::regclass
 loop execute format('alter table public.cross_branch_shift_requests drop constraint %I',constraint_name); end loop;
end $$;
alter table public.cross_branch_shift_requests add constraint cross_branch_home_branch_fk
 foreign key(organization_id,home_branch_id) references public.branches(organization_id,id) on delete restrict;
alter table public.cross_branch_shift_requests add constraint cross_branch_destination_branch_fk
 foreign key(organization_id,destination_branch_id) references public.branches(organization_id,id) on delete restrict;

alter table public.branch_access_events add column branch_name text;
update public.branch_access_events e set branch_name=b.name from public.branches b
 where b.organization_id=e.organization_id and b.id=e.branch_id;
alter table public.branch_access_events alter column branch_id drop not null;
alter table public.branch_access_events drop constraint branch_access_events_organization_id_branch_id_fkey;
alter table public.branch_access_events add constraint branch_access_events_branch_fk
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict;

alter table public.organization_invitations add column target_branch_name text;
update public.organization_invitations i set target_branch_name=b.name from public.branches b
 where b.organization_id=i.organization_id and b.id=i.target_branch_id;
alter table public.organization_invitations alter column target_branch_id drop not null;
alter table public.organization_invitations drop constraint invitations_target_branch_fk;
alter table public.organization_invitations add constraint invitations_target_branch_fk
 foreign key(organization_id,target_branch_id) references public.branches(organization_id,id) on delete restrict;

create or replace function public.cross_branch_shift_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(p_organization_id);
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
  'employee_name',e.name,'home_branch_name',coalesce(h.name,r.home_branch_name),
  'destination_branch_name',coalesce(d.name,r.destination_branch_name)) order by r.proposed_at desc)
  from public.cross_branch_shift_requests r join public.employees e on e.organization_id=r.organization_id and e.id=r.employee_id
  left join public.branches h on h.organization_id=r.organization_id and h.id=r.home_branch_id
  left join public.branches d on d.organization_id=r.organization_id and d.id=r.destination_branch_id
  where r.organization_id=p_organization_id and (
   m.organization_role='owner' or planner_private.can_operate_branch(p_organization_id,r.home_branch_id,true) or
   planner_private.can_operate_branch(p_organization_id,r.destination_branch_id,true) or
   (m.role='viewer' and m.employee_id=r.employee_id))),'[]'::jsonb);
end $$;

create or replace function public.branch_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.id,'organization_id',b.organization_id,'name',b.name,'active',b.active,
  'control_state',b.control_state,'is_primary',facts.is_primary,'is_last_active',facts.is_last_active,
  'can_delete',not facts.is_primary and not facts.is_last_branch and not facts.is_last_active and blockers.total=0,
  'delete_reasons',to_jsonb(array_remove(array[
   case when facts.is_primary then 'primary_branch' end,case when facts.is_last_branch then 'last_branch' end,
   case when facts.is_last_active then 'last_active_branch' end,case when blockers.total>0 then 'active_blockers' end
  ],null)),
  'blocker_counts',jsonb_build_object(
   'requests',blockers.requests,'cross_branch_requests',blockers.cross_branch_requests,
   'assignments',blockers.assignments,'shifts',blockers.shifts,'notes',blockers.notes,'invitations',blockers.invitations),
  'history_counts',jsonb_build_object(
   'requests',history.requests,'cross_branch_requests',history.cross_branch_requests,
   'memberships',history.memberships,'invitations',history.invitations,'audit_events',history.audit_events),
  'admins',coalesce((select jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'full_name',p.full_name,'is_primary',bm.is_primary,'is_active',bm.is_active)
   order by bm.is_primary desc,p.full_name) from public.branch_memberships bm join public.profiles p on p.user_id=bm.user_id
   where bm.branch_id=b.id and bm.role='branch_admin'),'[]'::jsonb)
 ) order by b.created_at,b.id),'[]'::jsonb) into result
 from public.branches b
 cross join lateral (select
  b.id=(select x.id from public.branches x where x.organization_id=b.organization_id order by x.created_at,x.id limit 1) is_primary,
  (select count(*) from public.branches x where x.organization_id=b.organization_id)=1 is_last_branch,
  b.active and (select count(*) from public.branches x where x.organization_id=b.organization_id and x.active)=1 is_last_active) facts
 cross join lateral (select requests,cross_branch_requests,assignments,shifts,notes,invitations,
  requests+cross_branch_requests+assignments+shifts+notes+invitations total from (select
   (select count(*) from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id and x.status='pending') requests,
   (select count(*) from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id) and x.status='pending') cross_branch_requests,
   (select count(*) from public.branch_memberships x where x.organization_id=b.organization_id and x.branch_id=b.id and x.is_active)
    +(select count(*) from public.employees x where x.organization_id=b.organization_id and x.home_branch_id=b.id)
    +(select count(*) from public.employee_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id)
    +(select count(*) from public.user_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id) assignments,
   (select count(*) from public.shifts x where x.organization_id=b.organization_id and x.branch_id=b.id) shifts,
   (select count(*) from public.notes x where x.organization_id=b.organization_id and x.branch_id=b.id) notes,
   (select count(*) from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id and x.accepted_at is null and x.revoked_at is null and x.expires_at>now()) invitations) q) blockers
 cross join lateral (select
   (select count(*) from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id and x.status<>'pending') requests,
   (select count(*) from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id) and x.status<>'pending') cross_branch_requests,
   (select count(*) from public.branch_memberships x where x.organization_id=b.organization_id and x.branch_id=b.id and not x.is_active) memberships,
   (select count(*) from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id and not (x.accepted_at is null and x.revoked_at is null and x.expires_at>now())) invitations,
   (select count(*) from public.branch_access_events x where x.organization_id=b.organization_id and x.branch_id=b.id) audit_events) history
 where b.organization_id=p_organization_id and (m.organization_role='owner' or exists(select 1 from public.branch_memberships x
  where x.branch_id=b.id and x.user_id=m.user_id and x.is_active));
 return result;
end $$;

create or replace function public.branch_delete_empty(p_organization_id uuid,p_branch_id uuid,p_confirmation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches; primary_id uuid;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id for update;
 if not found then raise exception 'Branch not found'; end if;
 if p_confirmation is distinct from 'ELIMINA '||b.name then raise exception 'Explicit branch deletion confirmation required'; end if;
 select id into primary_id from public.branches where organization_id=p_organization_id order by created_at,id limit 1;
 if b.id=primary_id then raise exception 'Primary branch cannot be permanently deleted'; end if;
 if (select count(*) from public.branches where organization_id=p_organization_id)<=1 then raise exception 'The last branch cannot be permanently deleted'; end if;
 if b.active and (select count(*) from public.branches where organization_id=p_organization_id and active)<=1 then raise exception 'The last active branch cannot be permanently deleted'; end if;
 if exists(select 1 from public.branch_memberships where organization_id=p_organization_id and branch_id=b.id and is_active)
  or exists(select 1 from public.employees where organization_id=p_organization_id and home_branch_id=b.id)
  or exists(select 1 from public.shifts where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.notes where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.requests where organization_id=p_organization_id and approval_branch_id=b.id and status='pending')
  or exists(select 1 from public.organization_invitations where organization_id=p_organization_id and target_branch_id=b.id and accepted_at is null and revoked_at is null and expires_at>now())
  or exists(select 1 from public.cross_branch_shift_requests where organization_id=p_organization_id and (home_branch_id=b.id or destination_branch_id=b.id) and status='pending')
  or exists(select 1 from public.employee_branch_assignments where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.user_branch_assignments where organization_id=p_organization_id and branch_id=b.id)
 then raise exception 'Branch has active dependent data and cannot be permanently deleted'; end if;
 update public.requests set approval_branch_name=b.name,approval_branch_id=null where organization_id=p_organization_id and approval_branch_id=b.id;
 update public.cross_branch_shift_requests set home_branch_name=b.name,home_branch_id=null where organization_id=p_organization_id and home_branch_id=b.id;
 update public.cross_branch_shift_requests set destination_branch_name=b.name,destination_branch_id=null where organization_id=p_organization_id and destination_branch_id=b.id;
 update public.branch_access_events set branch_name=b.name,branch_id=null where organization_id=p_organization_id and branch_id=b.id;
 update public.organization_invitations set target_branch_name=b.name,target_branch_id=null where organization_id=p_organization_id and target_branch_id=b.id;
 delete from public.branch_memberships where organization_id=p_organization_id and branch_id=b.id and not is_active;
 delete from public.branch_planner_state where organization_id=p_organization_id and branch_id=b.id;
 delete from public.branches where organization_id=p_organization_id and id=b.id;
 return jsonb_build_object('organization_id',p_organization_id,'id',b.id,'name',b.name,'deleted',true);
end $$;

revoke all on function public.branch_delete_empty(uuid,uuid,text) from public,anon;
grant execute on function public.branch_delete_empty(uuid,uuid,text) to authenticated;
commit;
