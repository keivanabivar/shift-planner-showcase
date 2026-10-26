-- Keep empty secondary branches deletable after harmless lifecycle changes.
-- Apply once after 022. This migration is intentionally not applied automatically.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.branch_delete_empty(uuid,uuid,text)') is null
 or to_regclass('public.branch_planner_state') is null then
  raise exception '023 requires migration 022';
 end if;
end $$;

alter table public.branch_access_events drop constraint if exists branch_access_events_action_check;
alter table public.branch_access_events add constraint branch_access_events_action_check check(action in (
 'branch_created','branch_renamed','branch_deactivated','branch_activated','branch_admin_invited',
 'branch_admin_accepted','branch_handover_completed','branch_admin_added',
 'branch_admin_removed','branch_editor_added','primary_admin_changed','recovery_started','recovery_ended',
 'cross_branch_proposed','cross_branch_approved','cross_branch_rejected'
));

create or replace function public.branch_update(p_organization_id uuid,p_branch_id uuid,p_name text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches; old_name text; old_active boolean;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id for update;
 if not found or p_name is null or length(trim(p_name)) not between 1 and 200 or p_active is null then raise exception 'Invalid branch'; end if;
 old_name:=b.name;old_active:=b.active;
 if old_active and not p_active and (select count(*) from public.branches where organization_id=p_organization_id and active)<=1 then
  raise exception 'The last active branch cannot be deactivated';
 end if;
 if old_active and not p_active and (exists(select 1 from public.shifts where organization_id=p_organization_id and branch_id=p_branch_id and date>=current_date)
  or exists(select 1 from public.organization_invitations where organization_id=p_organization_id and target_branch_id=p_branch_id and accepted_at is null and revoked_at is null and expires_at>now()))
 then raise exception 'Branch still has active operations'; end if;
 update public.branches set name=trim(p_name),active=p_active,updated_at=now() where organization_id=p_organization_id and id=p_branch_id returning * into b;
 if old_name is distinct from b.name then insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
  values(p_organization_id,p_branch_id,auth.uid(),'branch_renamed',jsonb_build_object('from',old_name,'to',b.name)); end if;
 if old_active is distinct from b.active then insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action)
  values(p_organization_id,p_branch_id,auth.uid(),case when b.active then 'branch_activated' else 'branch_deactivated' end); end if;
 return to_jsonb(b);
end $$;

create or replace function public.branch_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.id,'organization_id',b.organization_id,'name',b.name,'active',b.active,
  'control_state',b.control_state,
  'is_primary',b.id=(select x.id from public.branches x where x.organization_id=b.organization_id order by x.created_at,x.id limit 1),
  'can_delete',b.id<>(select x.id from public.branches x where x.organization_id=b.organization_id order by x.created_at,x.id limit 1)
   and (select count(*) from public.branches x where x.organization_id=b.organization_id)>1
   and not exists(select 1 from public.branch_memberships x where x.organization_id=b.organization_id and x.branch_id=b.id)
   and not exists(select 1 from public.employees x where x.organization_id=b.organization_id and x.home_branch_id=b.id)
   and not exists(select 1 from public.shifts x where x.organization_id=b.organization_id and x.branch_id=b.id)
   and not exists(select 1 from public.notes x where x.organization_id=b.organization_id and x.branch_id=b.id)
   and not exists(select 1 from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id)
   and not exists(select 1 from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id)
   and not exists(select 1 from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id))
   and not exists(select 1 from public.employee_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id)
   and not exists(select 1 from public.user_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id)
   and not exists(select 1 from public.branch_access_events x where x.organization_id=b.organization_id and x.branch_id=b.id
    and x.action not in ('branch_created','branch_deactivated','branch_activated')),
  'admins',coalesce((select jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'full_name',p.full_name,'is_primary',bm.is_primary,'is_active',bm.is_active)
   order by bm.is_primary desc,p.full_name) from public.branch_memberships bm join public.profiles p on p.user_id=bm.user_id
   where bm.branch_id=b.id and bm.role='branch_admin'),'[]'::jsonb)
 ) order by b.created_at,b.id),'[]'::jsonb) into result from public.branches b where b.organization_id=p_organization_id
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
