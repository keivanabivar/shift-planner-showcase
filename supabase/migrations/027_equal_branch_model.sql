-- Make every branch an equal, optional operational scope.
-- Apply once after 026. This migration is intentionally not applied automatically.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.branch_delete_empty(uuid,uuid,text)') is null
 or to_regprocedure('public.organization_onboard(text,text,text)') is null then
  raise exception '027 requires migrations 017 through 026';
 end if;
end $$;

-- Owner authority is organization-wide. Remove only legacy memberships for which
-- the Owner has no explicit operational assignment; real user assignments remain.
delete from public.branch_memberships bm
using public.profiles p
where p.organization_id=bm.organization_id and p.user_id=bm.user_id
 and p.organization_role='owner'
 and not exists(select 1 from public.user_branch_assignments a
  where a.organization_id=bm.organization_id and a.user_id=bm.user_id and a.branch_id=bm.branch_id);

create or replace function public.organization_onboard(organization_name text,manager_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); oid uuid; bid uuid;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 perform 1 from auth.users where id=uid and email_confirmed_at is not null for update;
 if not found then raise exception 'Confirmed email required' using errcode='42501'; end if;
 if exists(select 1 from public.profiles where user_id=uid) then return public.account_context(); end if;
 if organization_name is null or length(trim(organization_name)) not between 1 and 200
 or manager_name is null or length(trim(manager_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 insert into public.organizations(name) values(trim(organization_name)) returning id into oid;
 insert into public.planner_state(organization_id,id) values(oid,true);
 insert into public.profiles(user_id,organization_id,full_name,role,organization_role,visibility_level)
 values(uid,oid,trim(manager_name),'admin','owner','all_branches');
 -- Compatibility for deployed two-argument clients: this is an ordinary branch,
 -- named after the organization, with no special first/primary semantics.
 insert into public.branches(organization_id,name,control_state,created_by)
 values(oid,trim(organization_name),'managed',uid) returning id into bid;
 insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary)
 values(oid,bid,uid,'branch_admin',true);
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action)
 values(oid,bid,uid,uid,'branch_created'),(oid,bid,uid,uid,'branch_admin_added');
 return public.account_context();
end $$;

create or replace function public.organization_onboard(organization_name text,manager_name text,first_branch_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; oid uuid; created jsonb;
begin
 if first_branch_name is null or length(trim(first_branch_name)) not between 1 and 200 then raise exception 'Invalid branch name'; end if;
 result:=public.organization_onboard(organization_name,manager_name);
 oid:=(result->>'organization_id')::uuid;
 select jsonb_build_object('id',id) into created from public.branches where organization_id=oid order by created_at,id limit 1;
 update public.branches set name=trim(first_branch_name),control_state='setup',updated_at=now() where organization_id=oid and id=(created->>'id')::uuid;
 delete from public.branch_memberships bm using public.profiles p where bm.organization_id=oid and bm.user_id=p.user_id and p.organization_role='owner';
 return public.account_context();
end $$;

create or replace function public.branch_update(p_organization_id uuid,p_branch_id uuid,p_name text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches; old_name text; old_active boolean;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id for update;
 if not found or p_name is null or length(trim(p_name)) not between 1 and 200 or p_active is null then raise exception 'Invalid branch'; end if;
 old_name:=b.name;old_active:=b.active;
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
  'id',b.id,'organization_id',b.organization_id,'name',b.name,'active',b.active,'control_state',b.control_state,
  'can_delete',blockers.total=0,
  'delete_reasons',case when blockers.total>0 then '["active_blockers"]'::jsonb else '[]'::jsonb end,
  'blocker_counts',jsonb_build_object(
   'requests',blockers.requests,'cross_branch_requests',blockers.cross_branch_requests,
   'memberships',blockers.memberships,'user_assignments',blockers.user_assignments,
   'employee_assignments',blockers.employee_assignments,'shifts',blockers.shifts,
   'notes',blockers.notes,'invitations',blockers.invitations),
  'history_counts',jsonb_build_object(
   'requests',history.requests,'cross_branch_requests',history.cross_branch_requests,
   'memberships',history.memberships,'invitations',history.invitations,'audit_events',history.audit_events),
  'admins',coalesce((select jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'full_name',p.full_name,'is_primary',bm.is_primary,'is_active',bm.is_active)
   order by bm.is_primary desc,p.full_name) from public.branch_memberships bm join public.profiles p on p.user_id=bm.user_id
   where bm.branch_id=b.id and bm.role='branch_admin' and p.organization_role<>'owner'),'[]'::jsonb)
 ) order by b.created_at,b.id),'[]'::jsonb) into result
 from public.branches b
 cross join lateral (select requests,cross_branch_requests,memberships,user_assignments,employee_assignments,shifts,notes,invitations,
  requests+cross_branch_requests+memberships+user_assignments+employee_assignments+shifts+notes+invitations total from (select
   (select count(*) from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id and x.status='pending') requests,
   (select count(*) from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id) and x.status='pending') cross_branch_requests,
   (select count(*) from public.branch_memberships x join public.profiles p on p.user_id=x.user_id and p.organization_id=x.organization_id where x.organization_id=b.organization_id and x.branch_id=b.id and x.is_active and p.organization_role<>'owner') memberships,
   (select count(*) from public.user_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id) user_assignments,
   (select count(*) from (select x.employee_id from public.employee_branch_assignments x where x.organization_id=b.organization_id and x.branch_id=b.id union select x.id from public.employees x where x.organization_id=b.organization_id and x.home_branch_id=b.id) employees) employee_assignments,
   (select count(*) from public.shifts x where x.organization_id=b.organization_id and x.branch_id=b.id) shifts,
   (select count(*) from public.notes x where x.organization_id=b.organization_id and x.branch_id=b.id) notes,
   (select count(*) from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id and x.accepted_at is null and x.revoked_at is null and x.expires_at>now()) invitations) q) blockers
 cross join lateral (select
   (select count(*) from public.requests x where x.organization_id=b.organization_id and x.approval_branch_id=b.id and x.status<>'pending') requests,
   (select count(*) from public.cross_branch_shift_requests x where x.organization_id=b.organization_id and (x.home_branch_id=b.id or x.destination_branch_id=b.id) and x.status<>'pending') cross_branch_requests,
   (select count(*) from public.branch_memberships x where x.organization_id=b.organization_id and x.branch_id=b.id and not x.is_active) memberships,
   (select count(*) from public.organization_invitations x where x.organization_id=b.organization_id and x.target_branch_id=b.id and not (x.accepted_at is null and x.revoked_at is null and x.expires_at>now())) invitations,
   (select count(*) from public.branch_access_events x where x.organization_id=b.organization_id and x.branch_id=b.id) audit_events) history
 where b.organization_id=p_organization_id and (m.organization_role='owner' or exists(select 1 from public.branch_memberships x where x.branch_id=b.id and x.user_id=m.user_id and x.is_active));
 return result;
end $$;

create or replace function public.branch_delete_empty(p_organization_id uuid,p_branch_id uuid,p_confirmation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id for update;
 if not found then raise exception 'Branch not found'; end if;
 if p_confirmation is distinct from 'ELIMINA '||b.name then raise exception 'Explicit branch deletion confirmation required'; end if;
 delete from public.branch_memberships bm using public.profiles p where bm.organization_id=p_organization_id and bm.branch_id=b.id and bm.user_id=p.user_id and p.organization_role='owner';
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

-- Future Owner assignment edits also discard legacy memberships outside the
-- explicitly selected operational scopes.
create or replace function planner_private.cleanup_owner_branch_memberships(p_organization_id uuid,p_user_id uuid) returns void
language sql security definer set search_path='' as $$
 delete from public.branch_memberships bm using public.profiles p
 where bm.organization_id=p_organization_id and bm.user_id=p_user_id
  and p.organization_id=bm.organization_id and p.user_id=bm.user_id and p.organization_role='owner'
  and not exists(select 1 from public.user_branch_assignments a where a.organization_id=bm.organization_id and a.user_id=bm.user_id and a.branch_id=bm.branch_id)
$$;

create or replace function planner_private.cleanup_owner_membership_after_assignment_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.cleanup_owner_branch_memberships(old.organization_id,old.user_id);
 return old;
end $$;
drop trigger if exists user_branch_assignment_owner_cleanup on public.user_branch_assignments;
create trigger user_branch_assignment_owner_cleanup after delete on public.user_branch_assignments
for each row execute function planner_private.cleanup_owner_membership_after_assignment_delete();

commit;
