-- Explain why a branch cannot be permanently deleted and expose dependency counts.
-- Apply once after 024. This migration is intentionally not applied automatically.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.branch_delete_empty(uuid,uuid,text)') is null
 or to_regclass('public.user_branch_assignments') is null then
  raise exception '025 requires migrations 017 through 024';
 end if;
end $$;

create or replace function public.branch_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.id,'organization_id',b.organization_id,'name',b.name,'active',b.active,
  'control_state',b.control_state,'is_primary',facts.is_primary,'is_last_active',facts.is_last_active,
  'can_delete',not facts.is_primary and not facts.is_last_branch and not facts.is_last_active and deps.total=0,
  'delete_reasons',to_jsonb(array_remove(array[
   case when facts.is_primary then 'primary_branch' end,
   case when facts.is_last_branch then 'last_branch' end,
   case when facts.is_last_active then 'last_active_branch' end,
   case when deps.total>0 then 'dependent_data' end
  ],null)),
  'dependency_counts',jsonb_build_object(
   'requests',deps.requests,'cross_branch_requests',deps.cross_branch_requests,
   'assignments',deps.assignments,'shifts',deps.shifts,'notes',deps.notes,
   'invitations',deps.invitations,'audit_events',deps.audit_events
  ),
  'admins',coalesce((select jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'full_name',p.full_name,'is_primary',bm.is_primary,'is_active',bm.is_active)
   order by bm.is_primary desc,p.full_name) from public.branch_memberships bm join public.profiles p on p.user_id=bm.user_id
   where bm.branch_id=b.id and bm.role='branch_admin'),'[]'::jsonb)
 ) order by b.created_at,b.id),'[]'::jsonb) into result
 from public.branches b
 cross join lateral (
  select
   b.id=(select x.id from public.branches x where x.organization_id=b.organization_id order by x.created_at,x.id limit 1) as is_primary,
   (select count(*) from public.branches x where x.organization_id=b.organization_id)=1 as is_last_branch,
   b.active and (select count(*) from public.branches x where x.organization_id=b.organization_id and x.active)=1 as is_last_active
 ) facts
 cross join lateral (
  select requests,cross_branch_requests,assignments,shifts,notes,invitations,audit_events,
   requests+cross_branch_requests+assignments+shifts+notes+invitations+audit_events as total
  from (
   select
    (select count(*) from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id) as requests,
    (select count(*) from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id)) as cross_branch_requests,
    (select count(*) from public.branch_memberships x where x.organization_id=b.organization_id and x.branch_id=b.id)
     +(select count(*) from public.employees x where x.organization_id=b.organization_id and x.home_branch_id=b.id)
     +(select count(*) from public.employee_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id)
     +(select count(*) from public.user_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id) as assignments,
    (select count(*) from public.shifts x where x.organization_id=b.organization_id and x.branch_id=b.id) as shifts,
    (select count(*) from public.notes x where x.organization_id=b.organization_id and x.branch_id=b.id) as notes,
    (select count(*) from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id) as invitations,
    (select count(*) from public.branch_access_events x where x.organization_id=b.organization_id and x.branch_id=b.id
     and x.action not in ('branch_created','branch_deactivated','branch_activated')) as audit_events
  ) counts
 ) deps
 where b.organization_id=p_organization_id
 and (m.organization_role='owner' or exists(select 1 from public.branch_memberships x
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
 if b.active and (select count(*) from public.branches where organization_id=p_organization_id and active)<=1 then
  raise exception 'The last active branch cannot be permanently deleted';
 end if;
 if exists(select 1 from public.branch_memberships where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.employees where organization_id=p_organization_id and home_branch_id=b.id)
  or exists(select 1 from public.shifts where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.notes where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.requests where organization_id=p_organization_id and approval_branch_id=b.id)
  or exists(select 1 from public.organization_invitations where organization_id=p_organization_id and target_branch_id=b.id)
  or exists(select 1 from public.cross_branch_shift_requests where organization_id=p_organization_id and (home_branch_id=b.id or destination_branch_id=b.id))
  or exists(select 1 from public.employee_branch_assignments where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.user_branch_assignments where organization_id=p_organization_id and branch_id=b.id)
  or exists(select 1 from public.branch_access_events where organization_id=p_organization_id and branch_id=b.id
   and action not in ('branch_created','branch_deactivated','branch_activated'))
 then raise exception 'Branch has dependent data and cannot be permanently deleted'; end if;
 delete from public.branch_access_events where organization_id=p_organization_id and branch_id=b.id
  and action in ('branch_created','branch_deactivated','branch_activated');
 delete from public.branch_planner_state where organization_id=p_organization_id and branch_id=b.id;
 delete from public.branches where organization_id=p_organization_id and id=b.id;
 return jsonb_build_object('organization_id',p_organization_id,'id',b.id,'deleted',true);
end $$;

revoke all on function public.branch_delete_empty(uuid,uuid,text) from public,anon;
grant execute on function public.branch_delete_empty(uuid,uuid,text) to authenticated;

commit;
