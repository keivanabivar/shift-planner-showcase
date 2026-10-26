-- Separate organization ownership from operational branch assignments.
-- Apply once after 023. This migration is intentionally not applied automatically.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.branch_member_assignments_update(uuid,uuid,text,text,text,boolean,uuid[])') is null
 or to_regclass('public.user_branch_assignments') is null
 or to_regprocedure('public.branch_delete_empty(uuid,uuid,text)') is null then
  raise exception '024 requires migration 023';
 end if;
end $$;

create or replace function planner_private.can_operate_branch(p_oid uuid,p_branch_id uuid,p_admin_only boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.branches b where b.organization_id=p_oid and b.id=p_branch_id and b.active and (
  exists(select 1 from public.branch_memberships bm where bm.organization_id=p_oid and bm.branch_id=b.id
   and bm.user_id=auth.uid() and bm.is_active and (not p_admin_only or bm.role='branch_admin'))
  or (planner_private.is_owner(p_oid) and (
   exists(select 1 from public.user_branch_assignments uba where uba.organization_id=p_oid
    and uba.branch_id=b.id and uba.user_id=auth.uid())
   or b.control_state in ('setup','recovery')
  ))
 ))
$$;

create or replace function public.branch_member_assignments_update(p_organization_id uuid,p_user_id uuid,p_role text,p_employee_id text,
 p_visibility_level text,p_is_active boolean,p_branch_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; target public.profiles; bid uuid; first_bid uuid; result jsonb;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then raise exception 'Access denied' using errcode='42501'; end if;
 if p_branch_ids is null then p_branch_ids:='{}'::uuid[]; end if;
 if exists(select 1 from unnest(p_branch_ids) x left join public.branches b on b.organization_id=p_organization_id and b.id=x where b.id is null or not b.active) then raise exception 'Invalid branch'; end if;
 select * into target from public.profiles where organization_id=p_organization_id and user_id=p_user_id for update;
 if not found then raise exception 'Member not found'; end if;

 if target.organization_role='owner' then
  if actor.organization_role<>'owner' then raise exception 'Access denied' using errcode='42501'; end if;
  if p_role<>'branch_admin' or not p_is_active or p_visibility_level not in ('own','home_branch','all_branches') then raise exception 'Organization Owner access cannot be removed here'; end if;
  delete from public.user_branch_assignments where organization_id=p_organization_id and user_id=p_user_id;
  insert into public.user_branch_assignments(organization_id,user_id,branch_id)
   select p_organization_id,p_user_id,x from unnest(p_branch_ids) x on conflict do nothing;

  -- Old migrations created an Owner branch_admin membership. Remove it when another
  -- real Branch Admin protects the branch, or when the branch is otherwise empty.
  delete from public.branch_memberships legacy
   where legacy.organization_id=p_organization_id and legacy.user_id=p_user_id
    and (
     exists(select 1 from public.branch_memberships other where other.organization_id=legacy.organization_id
      and other.branch_id=legacy.branch_id and other.user_id<>legacy.user_id and other.role='branch_admin' and other.is_active)
     or (
      not exists(select 1 from public.employees x where x.organization_id=legacy.organization_id and x.home_branch_id=legacy.branch_id)
      and not exists(select 1 from public.shifts x where x.organization_id=legacy.organization_id and x.branch_id=legacy.branch_id)
      and not exists(select 1 from public.notes x where x.organization_id=legacy.organization_id and x.branch_id=legacy.branch_id)
      and not exists(select 1 from public.requests x where x.organization_id=legacy.organization_id and x.approval_branch_id=legacy.branch_id)
      and not exists(select 1 from public.organization_invitations x where x.organization_id=legacy.organization_id and x.target_branch_id=legacy.branch_id)
      and not exists(select 1 from public.cross_branch_shift_requests x where x.organization_id=legacy.organization_id and (x.home_branch_id=legacy.branch_id or x.destination_branch_id=legacy.branch_id))
      and not exists(select 1 from public.employee_branch_assignments x where x.organization_id=legacy.organization_id and x.branch_id=legacy.branch_id)
      and not exists(select 1 from public.user_branch_assignments x where x.organization_id=legacy.organization_id and x.branch_id=legacy.branch_id and x.user_id<>p_user_id)
      and not exists(select 1 from public.branch_access_events x where x.organization_id=legacy.organization_id and x.branch_id=legacy.branch_id and x.action not in ('branch_created','branch_deactivated','branch_activated'))
     )
    );
  update public.profiles set role='admin',employee_id=p_employee_id,visibility_level=p_visibility_level,is_active=true,updated_at=now()
   where organization_id=p_organization_id and user_id=p_user_id;
  return jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'role','branch_admin',
   'employee_id',p_employee_id,'visibility_level',p_visibility_level,'is_active',true,'branch_ids',to_jsonb(p_branch_ids));
 end if;

 if coalesce(cardinality(p_branch_ids),0)=0 then raise exception 'At least one branch is required'; end if;
 if exists(select 1 from public.branch_memberships current
  where current.organization_id=p_organization_id and current.user_id=p_user_id and current.role='branch_admin' and current.is_active
   and (p_role<>'branch_admin' or not(current.branch_id=any(p_branch_ids)))
   and not exists(select 1 from public.branch_memberships other where other.organization_id=current.organization_id and other.branch_id=current.branch_id and other.user_id<>p_user_id and other.role='branch_admin' and other.is_active))
 then raise exception 'Cannot remove the last active Branch Admin'; end if;
 select x into first_bid from unnest(p_branch_ids) x limit 1;
 result:=public.branch_member_update(p_organization_id,first_bid,p_user_id,p_role,p_employee_id,p_visibility_level,p_is_active);
 delete from public.user_branch_assignments where organization_id=p_organization_id and user_id=p_user_id;
 insert into public.user_branch_assignments(organization_id,user_id,branch_id) select p_organization_id,p_user_id,x from unnest(p_branch_ids) x on conflict do nothing;
 if p_role in ('branch_admin','editor') then
  update public.branch_memberships set is_active=false,is_primary=false,updated_at=now()
   where organization_id=p_organization_id and user_id=p_user_id and not(branch_id=any(p_branch_ids));
  foreach bid in array p_branch_ids loop
   if bid<>first_bid then perform public.branch_member_update(p_organization_id,bid,p_user_id,p_role,p_employee_id,p_visibility_level,p_is_active); end if;
  end loop;
 end if;
 return result||jsonb_build_object('branch_ids',to_jsonb(p_branch_ids));
end $$;

create or replace function public.branch_access_overview(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then raise exception 'Access denied' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'organization_id',p.organization_id,'user_id',p.user_id,'full_name',p.full_name,'employee_id',p.employee_id,
  'is_active',p.is_active,'organization_role',p.organization_role,'visibility_level',p.visibility_level,
  'role',case when p.organization_role='owner' then 'branch_admin'
              when exists(select 1 from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.role='branch_admin' and bm.is_active) then 'branch_admin'
              when exists(select 1 from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.role='editor' and bm.is_active) then 'editor'
              when p.employee_id is not null then 'employee' else 'viewer' end,
  'branch_id',(select x.branch_id from (select uba.branch_id from public.user_branch_assignments uba where uba.organization_id=p.organization_id and uba.user_id=p.user_id
    union select bm.branch_id from public.branch_memberships bm where p.organization_role<>'owner' and bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.is_active
    union select i.target_branch_id from public.organization_invitations i where p.organization_role<>'owner' and i.organization_id=p.organization_id and i.accepted_by=p.user_id and i.accepted_at is not null and i.target_branch_id is not null) x order by x.branch_id limit 1),
  'branch_ids',coalesce((select jsonb_agg(x.branch_id order by x.branch_id) from (
    select uba.branch_id from public.user_branch_assignments uba where uba.organization_id=p.organization_id and uba.user_id=p.user_id
    union select bm.branch_id from public.branch_memberships bm where p.organization_role<>'owner' and bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.is_active
    union select i.target_branch_id from public.organization_invitations i where p.organization_role<>'owner' and i.organization_id=p.organization_id and i.accepted_by=p.user_id and i.accepted_at is not null and i.target_branch_id is not null
   ) x),'[]'::jsonb)
 ) order by p.created_at,p.user_id) from public.profiles p where p.organization_id=p_organization_id),'[]'::jsonb);
end $$;

commit;
