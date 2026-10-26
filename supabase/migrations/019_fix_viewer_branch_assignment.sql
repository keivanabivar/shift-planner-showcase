create or replace function public.branch_member_update(p_organization_id uuid,p_branch_id uuid,p_user_id uuid,p_role text,
 p_employee_id text default null,p_visibility_level text default 'all_branches',p_is_active boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; target public.profiles; mapped text; admins integer;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' then perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,true); end if;
 if p_role not in ('branch_admin','editor','employee','viewer') or p_visibility_level not in ('own','home_branch','all_branches') or p_is_active is null then raise exception 'Invalid access'; end if;
 select * into target from public.profiles where organization_id=p_organization_id and user_id=p_user_id for update;
 if not found then raise exception 'Member not found'; end if;
 if target.organization_role='owner' and (not p_is_active or p_role<>'branch_admin') then raise exception 'Organization Owner access cannot be removed here'; end if;
 if exists(select 1 from public.branch_memberships where organization_id=p_organization_id and branch_id=p_branch_id and user_id=p_user_id and role='branch_admin' and is_active)
 and (p_role<>'branch_admin' or not p_is_active) then
  select count(*) into admins from public.branch_memberships where organization_id=p_organization_id and branch_id=p_branch_id and role='branch_admin' and is_active and user_id<>p_user_id;
  if admins=0 then raise exception 'Cannot remove the last active Branch Admin'; end if;
 end if;
 if p_role in ('branch_admin','editor') then
  insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_active)
  values(p_organization_id,p_branch_id,p_user_id,p_role,p_is_active)
  on conflict(branch_id,user_id) do update set role=excluded.role,is_active=excluded.is_active,updated_at=now();
 else
  update public.branch_memberships set is_active=false,is_primary=false,updated_at=now() where branch_id=p_branch_id and user_id=p_user_id;
  update public.organization_invitations set target_branch_id=p_branch_id
  where organization_id=p_organization_id and accepted_by=p_user_id and accepted_at is not null;
 end if;
 mapped:=case
  when exists(select 1 from public.branch_memberships where organization_id=p_organization_id and user_id=p_user_id and role='branch_admin' and is_active) then 'admin'
  when exists(select 1 from public.branch_memberships where organization_id=p_organization_id and user_id=p_user_id and role='editor' and is_active) then 'editor'
  else 'viewer' end;
 update public.profiles set role=mapped,employee_id=p_employee_id,visibility_level=p_visibility_level,is_active=p_is_active,updated_at=now() where user_id=p_user_id;
 return jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'branch_id',p_branch_id,'role',p_role,
  'employee_id',p_employee_id,'visibility_level',p_visibility_level,'is_active',p_is_active);
end $$;
