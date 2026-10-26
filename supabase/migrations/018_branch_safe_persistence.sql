-- Branch-scoped planner persistence. Apply once after 017.
-- No Cron, archive-retention, or production configuration changes are made here.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regclass('public.branches') is null
 or to_regprocedure('planner_private.lock_branch_operator(uuid,uuid,boolean)') is null then
  raise exception '018 requires migration 017';
 end if;
 if to_regclass('public.branch_planner_state') is not null then
  raise exception '018 already applied, or public.branch_planner_state exists: inspect before proceeding';
 end if;
end $$;

create table public.branch_planner_state(
 organization_id uuid not null,
 branch_id uuid not null,
 revision bigint not null default 0 check(revision>=0),
 updated_at timestamptz not null default now(),
 primary key(organization_id,branch_id),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict
);
insert into public.branch_planner_state(organization_id,branch_id,revision)
select organization_id,id,0 from public.branches;
alter table public.branch_planner_state enable row level security;
revoke all on public.branch_planner_state from public,anon,authenticated;

create function planner_private.ensure_branch_state(p_oid uuid,p_bid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into public.branch_planner_state(organization_id,branch_id) values(p_oid,p_bid)
 on conflict do nothing;
end $$;

create function planner_private.bump_branch_revision(p_oid uuid,p_bid uuid) returns bigint
language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
 perform planner_private.ensure_branch_state(p_oid,p_bid);
 update public.branch_planner_state set revision=revision+1,updated_at=now()
 where organization_id=p_oid and branch_id=p_bid returning revision into result;
 return result;
end $$;

-- New branches receive their independent revision row without changing 017.
create function planner_private.branch_state_after_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.branch_planner_state(organization_id,branch_id) values(new.organization_id,new.id)
 on conflict do nothing;
 return new;
end $$;
create trigger branches_create_planner_state after insert on public.branches
for each row execute function planner_private.branch_state_after_insert();

-- A three-argument onboarding contract lets the first site be named explicitly.
-- The two-argument 017 function remains available to older deployed clients.
create function public.organization_onboard(organization_name text,manager_name text,first_branch_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; oid uuid; bid uuid;
begin
 if first_branch_name is null or length(trim(first_branch_name)) not between 1 and 200 then
  raise exception 'Invalid branch name';
 end if;
 result:=public.organization_onboard(organization_name,manager_name);
 oid:=(result->>'organization_id')::uuid;
 select id into bid from public.branches where organization_id=oid order by created_at,id limit 1;
 update public.branches set name=trim(first_branch_name),updated_at=now() where organization_id=oid and id=bid;
 result:=jsonb_set(result,'{branches,0,name}',to_jsonb(trim(first_branch_name)),false);
 return result;
end $$;

create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 m public.profiles; allowed uuid[]; selected uuid[]; effective uuid[]; result jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);

 if m.role='viewer' then
  if m.visibility_level='own' then
   select array_agg(distinct x.bid) into allowed from (
    select e.home_branch_id bid from public.employees e
     where e.organization_id=p_organization_id and e.id=m.employee_id
    union select s.branch_id from public.shifts s
     where s.organization_id=p_organization_id and s.employee_id=m.employee_id
   ) x;
  elsif m.visibility_level='home_branch' then
   select array_agg(distinct x.bid) into allowed from (
    select e.home_branch_id bid from public.employees e
     where e.organization_id=p_organization_id and e.id=m.employee_id
    union select s.branch_id from public.shifts s join public.employees e
     on e.organization_id=s.organization_id and e.id=s.employee_id
     where e.organization_id=p_organization_id and e.home_branch_id=(
      select home_branch_id from public.employees where organization_id=p_organization_id and id=m.employee_id)
   ) x;
  else
   select array_agg(id order by created_at,id) into allowed from public.branches
    where organization_id=p_organization_id and active;
  end if;
 else
  select array_agg(b.id order by b.created_at,b.id) into allowed from public.branches b
   where b.organization_id=p_organization_id and b.active
   and planner_private.can_operate_branch(p_organization_id,b.id,false);
 end if;
 allowed:=coalesce(allowed,'{}'::uuid[]);
 if p_branch_ids is null or cardinality(p_branch_ids)=0 then selected:=allowed;
 else
  if exists(select 1 from unnest(p_branch_ids) q(id) where not (q.id=any(allowed))) then
   raise exception 'Branch scope denied' using errcode='42501';
  end if;
  select array_agg(distinct id) into selected from unnest(p_branch_ids) q(id);
 end if;
 selected:=coalesce(selected,'{}'::uuid[]);

 -- Cross-site assignments belonging to a selected home site are visible too.
 select array_agg(distinct x.bid) into effective from (
  select unnest(selected) bid
  union
  select s.branch_id from public.shifts s join public.employees e
   on e.organization_id=s.organization_id and e.id=s.employee_id
   where s.organization_id=p_organization_id and e.home_branch_id=any(selected)
   and (m.role<>'viewer' or m.visibility_level<>'own' or e.id=m.employee_id)
 ) x;
 effective:=coalesce(effective,selected);

 result:=jsonb_build_object(
  'organization_id',p_organization_id,
  'revision',(select coalesce(max(revision),0) from public.branch_planner_state where organization_id=p_organization_id and branch_id=any(effective)),
  'branch_revisions',coalesce((select jsonb_object_agg(branch_id::text,revision) from public.branch_planner_state where organization_id=p_organization_id and branch_id=any(effective)),'{}'::jsonb),
  'selected_branch_ids',to_jsonb(selected),
  'branches',coalesce((select jsonb_agg(jsonb_build_object(
    'id',b.id,'name',b.name,'active',b.active,'controlState',b.control_state,
    'readable',b.id=any(allowed),
    'operable',m.role<>'viewer' and planner_private.can_operate_branch(p_organization_id,b.id,false),
    'admin',m.role<>'viewer' and planner_private.can_operate_branch(p_organization_id,b.id,true)
   ) order by b.active desc,b.created_at,b.id) from public.branches b where b.organization_id=p_organization_id),'[]'::jsonb),
  'empty',not exists(select 1 from public.employees e where e.organization_id=p_organization_id and (
    (m.role='viewer' and m.visibility_level='own' and e.id=m.employee_id) or
    (not (m.role='viewer' and m.visibility_level='own') and (e.home_branch_id=any(selected) or exists(
      select 1 from public.shifts s where s.organization_id=e.organization_id and s.employee_id=e.id and s.branch_id=any(selected)))))),
  'snapshot',jsonb_build_object(
   'data',jsonb_build_object('version',1,
    'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'homeBranchId',e.home_branch_id) order by e.position,e.id)
     from public.employees e where e.organization_id=p_organization_id and (
      (m.role='viewer' and m.visibility_level='own' and e.id=m.employee_id) or
      (not (m.role='viewer' and m.visibility_level='own') and (e.home_branch_id=any(selected) or exists(
       select 1 from public.shifts s where s.organization_id=e.organization_id and s.employee_id=e.id and s.branch_id=any(selected)))))) ,'[]'::jsonb),
    'shifts',coalesce((select jsonb_object_agg(s.id,
      case when s.type in ('Riposo','Malattia','Ferie') then jsonb_build_object('type',s.type,'off',true,'branchId',s.branch_id)
      else jsonb_strip_nulls(jsonb_build_object('type',s.type,'off',false,'start',to_char(s.start_time,'HH24:MI'),'end',to_char(s.end_time,'HH24:MI'),
       'presetId',s.preset_id,'presetName',s.preset_name,'presetColor',s.preset_color,'branchId',s.branch_id)) end)
     from public.shifts s join public.employees e on e.organization_id=s.organization_id and e.id=s.employee_id
     where s.organization_id=p_organization_id and (
      (m.role='viewer' and m.visibility_level='own' and s.employee_id=m.employee_id) or
      (not (m.role='viewer' and m.visibility_level='own') and (s.branch_id=any(selected) or e.home_branch_id=any(selected))))),'{}'::jsonb)),
   'notes',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'text',n.text,'date',to_char(n.date,'YYYY-MM-DD'),
     'employeeId',coalesce(n.employee_id,''),'branchId',n.branch_id) order by n.position,n.id)
    from public.notes n where n.organization_id=p_organization_id and (n.branch_id is null or n.branch_id=any(selected))),'[]'::jsonb),
   'variations',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('employeeId',s.employee_id,'date',to_char(s.date,'YYYY-MM-DD'),
     'start',to_char(v.actual_start_time,'HH24:MI'),'end',to_char(v.actual_end_time,'HH24:MI'),'reason',v.reason,
     'customReason',v.custom_reason,'note',v.note,'branchId',s.branch_id))
    from public.attendance_variations v join public.shifts s on s.organization_id=v.organization_id and s.id=v.shift_id
    join public.employees e on e.organization_id=s.organization_id and e.id=s.employee_id
    where s.organization_id=p_organization_id and (
     (m.role='viewer' and m.visibility_level='own' and s.employee_id=m.employee_id) or
     (not (m.role='viewer' and m.visibility_level='own') and (s.branch_id=any(selected) or e.home_branch_id=any(selected))))),'{}'::jsonb),
   'settings',coalesce((select value from public.settings where organization_id=p_organization_id and id=true),'{}'::jsonb)
  )
 );
 return result;
end $$;

create function public.planner_apply_branch_operations(p_organization_id uuid,p_operations jsonb,p_expected_revisions jsonb,
 p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op jsonb; kind text; bid uuid; old_bid uuid; employee text; sid text; touched uuid[]:='{}'; current_revision bigint;
begin
 if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations)>5000
 or jsonb_typeof(p_expected_revisions) is distinct from 'object' then raise exception 'Invalid operation payload'; end if;

 -- Lock and compare every branch the client says it is changing.
 for bid in select distinct (x->>'branchId')::uuid from jsonb_array_elements(p_operations) x where nullif(x->>'branchId','') is not null loop
  perform planner_private.lock_branch_operator(p_organization_id,bid,false);
  perform planner_private.ensure_branch_state(p_organization_id,bid);
  select revision into current_revision from public.branch_planner_state where organization_id=p_organization_id and branch_id=bid for update;
  if not (p_expected_revisions ? bid::text) or current_revision is distinct from (p_expected_revisions->>bid::text)::bigint then
   raise exception 'Branch revision conflict' using errcode='40001';
  end if;
  touched:=array_append(touched,bid);
 end loop;

 for op in select value from jsonb_array_elements(p_operations) loop
  kind:=op->>'kind'; bid:=nullif(op->>'branchId','')::uuid; employee:=nullif(op->>'employeeId','');
  if kind='employee_upsert' then
   if nullif(trim(op->>'id'),'') is null or length(trim(op->>'name')) not between 1 and 100 then raise exception 'Invalid employee'; end if;
   select home_branch_id into old_bid from public.employees where organization_id=p_organization_id and id=op->>'id';
   if old_bid is not null and old_bid<>bid then
    perform planner_private.lock_branch_operator(p_organization_id,old_bid,false);
    perform planner_private.ensure_branch_state(p_organization_id,old_bid);
    select revision into current_revision from public.branch_planner_state where organization_id=p_organization_id and branch_id=old_bid for update;
    if not (p_expected_revisions ? old_bid::text) or current_revision is distinct from (p_expected_revisions->>old_bid::text)::bigint then raise exception 'Branch revision conflict' using errcode='40001'; end if;
    touched:=array_append(touched,old_bid);
   end if;
   insert into public.employees(organization_id,id,name,position,home_branch_id)
   values(p_organization_id,trim(op->>'id'),trim(op->>'name'),coalesce((op->>'position')::integer,0),bid)
   on conflict(organization_id,id) do update set name=excluded.name,position=excluded.position,home_branch_id=excluded.home_branch_id,updated_at=now();
  elsif kind='employee_delete' then
   -- Cascading deletion is allowed only when every affected site is explicitly locked.
   for old_bid in select distinct x from (select home_branch_id x from public.employees where organization_id=p_organization_id and id=op->>'id'
    union select branch_id from public.shifts where organization_id=p_organization_id and employee_id=op->>'id') q loop
    perform planner_private.lock_branch_operator(p_organization_id,old_bid,false);
    perform planner_private.ensure_branch_state(p_organization_id,old_bid);
    select revision into current_revision from public.branch_planner_state where organization_id=p_organization_id and branch_id=old_bid for update;
    if not (p_expected_revisions ? old_bid::text) or current_revision is distinct from (p_expected_revisions->>old_bid::text)::bigint then raise exception 'Branch revision conflict' using errcode='40001'; end if;
    touched:=array_append(touched,old_bid);
   end loop;
   delete from public.employees where organization_id=p_organization_id and id=op->>'id';
  elsif kind='shift_upsert' then
   sid:=op->>'id';
   select branch_id into old_bid from public.shifts where organization_id=p_organization_id and id=sid;
   if old_bid is not null and old_bid<>bid then raise exception 'Shift belongs to another branch' using errcode='42501'; end if;
   if old_bid is null and (select home_branch_id from public.employees where organization_id=p_organization_id and id=employee)<>bid then
    raise exception 'Cross-branch approval required' using errcode='42501';
   end if;
   insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id,preset_id,preset_name,preset_color)
   values(p_organization_id,sid,employee,(op->>'date')::date,op->>'type',nullif(op->>'start','')::time,nullif(op->>'end','')::time,bid,
    nullif(op->>'presetId',''),nullif(op->>'presetName',''),nullif(op->>'presetColor',''))
   on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,end_time=excluded.end_time,
    preset_id=excluded.preset_id,preset_name=excluded.preset_name,preset_color=excluded.preset_color,updated_at=now();
  elsif kind='shift_delete' then
   delete from public.shifts where organization_id=p_organization_id and id=op->>'id' and branch_id=bid;
  elsif kind='variation_upsert' then
   sid:=op->>'id';
   if not exists(select 1 from public.shifts where organization_id=p_organization_id and id=sid and branch_id=bid) then raise exception 'Shift not found in branch'; end if;
   insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note)
   values(p_organization_id,sid,sid,(op->>'start')::time,(op->>'end')::time,op->>'reason',coalesce(op->>'customReason',''),coalesce(op->>'note',''))
   on conflict(organization_id,id) do update set actual_start_time=excluded.actual_start_time,actual_end_time=excluded.actual_end_time,
    reason=excluded.reason,custom_reason=excluded.custom_reason,note=excluded.note,updated_at=now();
  elsif kind='variation_delete' then
   delete from public.attendance_variations v using public.shifts s where v.organization_id=p_organization_id and v.id=op->>'id'
    and s.organization_id=v.organization_id and s.id=v.shift_id and s.branch_id=bid;
  elsif kind='note_upsert' then
   perform public.branch_note_upsert(p_organization_id,bid,op->>'id',op->>'text',nullif(op->>'date','')::date,nullif(op->>'employeeId',''));
  elsif kind='note_delete' then
   delete from public.notes where organization_id=p_organization_id and id=op->>'id' and branch_id=bid;
  elsif kind='settings_update' then
   if (select count(*) from public.branches where organization_id=p_organization_id and active)<>1 then
    raise exception 'Shared settings require a dedicated multi-branch operation' using errcode='42501';
   end if;
   if jsonb_typeof(op->'value') is distinct from 'object' then raise exception 'Invalid settings'; end if;
   insert into public.settings(organization_id,id,value) values(p_organization_id,true,op->'value')
   on conflict(organization_id,id) do update set value=excluded.value,updated_at=now();
   perform planner_private.bump_revision(p_organization_id);
  else raise exception 'Unsupported planner operation: %',coalesce(kind,'null');
  end if;
 end loop;

 for bid in select distinct x from unnest(touched) q(x) loop perform planner_private.bump_branch_revision(p_organization_id,bid); end loop;
 return public.planner_load_scoped(p_organization_id,p_branch_ids);
end $$;

create function public.cross_branch_shift_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(p_organization_id);
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('employee_name',e.name,'home_branch_name',h.name,'destination_branch_name',d.name) order by r.proposed_at desc)
  from public.cross_branch_shift_requests r join public.employees e on e.organization_id=r.organization_id and e.id=r.employee_id
  join public.branches h on h.id=r.home_branch_id join public.branches d on d.id=r.destination_branch_id
  where r.organization_id=p_organization_id and (
   planner_private.can_operate_branch(p_organization_id,r.home_branch_id,true) or
   planner_private.can_operate_branch(p_organization_id,r.destination_branch_id,true) or
   (m.role='viewer' and m.employee_id=r.employee_id))),'[]'::jsonb);
end $$;

create function public.branch_access_overview(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then
  raise exception 'Branch Admin access required' using errcode='42501';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'user_id',p.user_id,'organization_id',p.organization_id,'full_name',p.full_name,'employee_id',p.employee_id,
  'is_active',p.is_active,'organization_role',p.organization_role,'visibility_level',p.visibility_level,
  'branch_id',x.branch_id,'role',coalesce(x.role,case when p.employee_id is null then 'viewer' else 'employee' end)
 ) order by p.created_at,p.user_id)
 from public.profiles p
 left join lateral (
  select scope.branch_id,scope.role from (
   select bm.branch_id,bm.role,bm.is_active,bm.is_primary,bm.created_at from public.branch_memberships bm
   where bm.organization_id=p.organization_id and bm.user_id=p.user_id
   union all
   select i.target_branch_id,i.target_role,true,false,i.created_at from public.organization_invitations i
   where i.organization_id=p.organization_id and i.accepted_by=p.user_id and i.accepted_at is not null
  ) scope
  where actor.organization_role='owner' or planner_private.can_operate_branch(p_organization_id,scope.branch_id,true)
  order by scope.is_active desc,scope.is_primary desc,scope.created_at limit 1
 ) x on true
 where p.organization_id=p_organization_id and (actor.organization_role='owner' or x.branch_id is not null)),'[]'::jsonb);
end $$;

create function public.branch_member_update(p_organization_id uuid,p_branch_id uuid,p_user_id uuid,p_role text,
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
 else update public.branch_memberships set is_active=false,is_primary=false,updated_at=now() where branch_id=p_branch_id and user_id=p_user_id; end if;
 mapped:=case
  when exists(select 1 from public.branch_memberships where organization_id=p_organization_id and user_id=p_user_id and role='branch_admin' and is_active) then 'admin'
  when exists(select 1 from public.branch_memberships where organization_id=p_organization_id and user_id=p_user_id and role='editor' and is_active) then 'editor'
  else 'viewer' end;
 update public.profiles set role=mapped,employee_id=p_employee_id,visibility_level=p_visibility_level,is_active=p_is_active,updated_at=now() where user_id=p_user_id;
 return jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'branch_id',p_branch_id,'role',p_role,
  'employee_id',p_employee_id,'visibility_level',p_visibility_level,'is_active',p_is_active);
end $$;

create function public.access_invite_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 actor:=planner_private.lock_member(p_organization_id);
 return coalesce((select jsonb_agg(to_jsonb(i)-'token_hash' order by i.created_at desc) from public.organization_invitations i
  where i.organization_id=p_organization_id and (actor.organization_role='owner' or planner_private.can_operate_branch(p_organization_id,i.target_branch_id,true))),'[]'::jsonb);
end $$;

create function public.access_invite_revoke(p_organization_id uuid,p_invitation_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; bid uuid;
begin
 actor:=planner_private.lock_member(p_organization_id);
 select target_branch_id into bid from public.organization_invitations where organization_id=p_organization_id and id=p_invitation_id;
 if bid is null then raise exception 'Invitation not found'; end if;
 if actor.organization_role<>'owner' then perform planner_private.lock_branch_operator(p_organization_id,bid,true); end if;
 update public.organization_invitations set revoked_at=now() where organization_id=p_organization_id and id=p_invitation_id and accepted_at is null and revoked_at is null;
end $$;

create or replace function public.request_approval_preview(p_organization_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; conflicts jsonb; overlap_ids jsonb; expected bigint;
begin
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id;
 if not found or r.status<>'pending' then raise exception 'Pending request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.approval_branch_id,false);
 select revision into expected from public.branch_planner_state where organization_id=p_organization_id and branch_id=r.approval_branch_id;
 select coalesce(jsonb_agg(jsonb_build_object('shift',to_jsonb(s),'variation',to_jsonb(v)) order by s.date),'[]'::jsonb)
 into conflicts from public.shifts s left join public.attendance_variations v on v.organization_id=s.organization_id and v.shift_id=s.id
 where s.organization_id=p_organization_id and s.employee_id=r.employee_id and s.date between r.start_date and r.end_date and r.type='Ferie';
 select coalesce(jsonb_agg(q.id),'[]'::jsonb) into overlap_ids from public.requests q
 where q.organization_id=p_organization_id and q.employee_id=r.employee_id and q.id<>r.id
 and coalesce(q.approved_type,q.type)='Ferie' and q.status='approved'
 and coalesce(q.approved_start_date,q.start_date)<=r.end_date and coalesce(q.approved_end_date,q.end_date)>=r.start_date and r.type='Ferie';
 return jsonb_build_object('request',to_jsonb(r),'expected_version',r.version,'expected_revision',expected,
  'conflicts',conflicts,'blocking_request_ids',overlap_ids,'requires_confirmation',jsonb_array_length(conflicts)>0);
end $$;

create or replace function public.request_approve(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint,p_confirm_replace boolean,p_note text,p_approved_type text,p_approved_start_date date,
 p_approved_end_date date,p_approved_start_time time default null,p_approved_end_time time default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; d date; sid text; prev jsonb; variation jsonb; applied jsonb; adjusted_value boolean; current_revision bigint;
begin
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id;
 if not found then raise exception 'Request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.approval_branch_id,false);
 select revision into current_revision from public.branch_planner_state where organization_id=p_organization_id and branch_id=r.approval_branch_id for update;
 if current_revision is distinct from p_expected_revision and not (
  (select count(*) from public.branches where organization_id=p_organization_id and active)=1
  and p_expected_revision=(select revision from public.planner_state where organization_id=p_organization_id and id=true)
 ) then raise exception 'Branch revision conflict' using errcode='40001'; end if;
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if r.status<>'pending' then raise exception 'Pending request not found'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 perform planner_private.validate_request(p_approved_type,p_approved_start_date,p_approved_end_date,p_approved_start_time,p_approved_end_time,p_note);
 adjusted_value:=(p_approved_type,p_approved_start_date,p_approved_end_date,p_approved_start_time,p_approved_end_time) is distinct from (r.type,r.start_date,r.end_date,r.start_time,r.end_time);
 if p_approved_type='Ferie' then
  if exists(select 1 from public.requests q where q.organization_id=p_organization_id and q.employee_id=r.employee_id and q.id<>r.id
   and coalesce(q.approved_type,q.type)='Ferie' and q.status='approved' and coalesce(q.approved_start_date,q.start_date)<=p_approved_end_date and coalesce(q.approved_end_date,q.end_date)>=p_approved_start_date)
   then raise exception 'Overlapping approved Ferie must be revoked first'; end if;
  if exists(select 1 from public.shifts where organization_id=p_organization_id and employee_id=r.employee_id
   and date between p_approved_start_date and p_approved_end_date and branch_id<>r.approval_branch_id)
   then raise exception 'A cross-branch shift must be resolved by its destination branch first' using errcode='42501'; end if;
  if not p_confirm_replace and exists(select 1 from public.shifts where organization_id=p_organization_id and employee_id=r.employee_id and date between p_approved_start_date and p_approved_end_date)
   then return jsonb_build_object('ok',false,'code','confirmation_required','request',to_jsonb(r)); end if;
  for d in select p_approved_start_date+n from generate_series(0,p_approved_end_date-p_approved_start_date) n loop
   sid:=r.employee_id||'|'||d::text;select to_jsonb(s) into prev from public.shifts s where organization_id=p_organization_id and id=sid;
   select to_jsonb(v) into variation from public.attendance_variations v where organization_id=p_organization_id and shift_id=sid;
   delete from public.attendance_variations where organization_id=p_organization_id and shift_id=sid;
   insert into public.shifts(organization_id,id,employee_id,date,type,source_request_id,branch_id)
   values(p_organization_id,sid,r.employee_id,d,'Ferie',r.id,r.approval_branch_id)
   on conflict(organization_id,id) do update set type='Ferie',start_time=null,end_time=null,preset_id=null,preset_name=null,
    preset_color=null,source_request_id=excluded.source_request_id,branch_id=excluded.branch_id,updated_at=now();
   select to_jsonb(s) into applied from public.shifts s where organization_id=p_organization_id and id=sid;
   insert into public.request_shift_changes(organization_id,request_id,employee_id,shift_date,previous_shift,previous_variation,applied_shift)
   values(p_organization_id,r.id,r.employee_id,d,prev,variation,applied);
  end loop;
  perform planner_private.bump_revision(p_organization_id);
  current_revision:=planner_private.bump_branch_revision(p_organization_id,r.approval_branch_id);
 end if;
 update public.requests set status='approved',decided_by_user_id=auth.uid(),decided_at=now(),decision_note=p_note,
  approved_type=p_approved_type,approved_start_date=p_approved_start_date,approved_end_date=p_approved_end_date,
  approved_start_time=p_approved_start_time,approved_end_time=p_approved_end_time,adjusted=adjusted_value,version=version+1,updated_at=now()
 where id=r.id returning * into r;perform planner_private.request_event(r,case when adjusted_value then 'approved_adjusted' else 'approved' end);
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',current_revision);
end $$;

create or replace function public.request_reject(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests;
begin
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id;
 if not found then raise exception 'Request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.approval_branch_id,false);
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if r.status<>'pending' then raise exception 'Pending request not found'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if p_note is null or length(p_note)>4000 then raise exception 'Invalid note'; end if;
 update public.requests set status='rejected',decided_by_user_id=auth.uid(),decided_at=now(),decision_note=p_note,
  version=version+1,updated_at=now() where id=r.id returning * into r;
 perform planner_private.request_event(r,'rejected');return to_jsonb(r);
end $$;

create or replace function public.request_revoke(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint,p_restore boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; b public.request_shift_changes; conflicts jsonb; current_revision bigint;
begin
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id;
 if not found then raise exception 'Request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.approval_branch_id,false);
 select revision into current_revision from public.branch_planner_state where organization_id=p_organization_id and branch_id=r.approval_branch_id for update;
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if r.status<>'approved' then raise exception 'Approved request not found'; end if;
 if r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if p_note is null or length(p_note)>4000 or p_restore is null then raise exception 'Invalid revocation'; end if;
 if coalesce(r.approved_type,r.type)='Ferie' then
  if current_revision is distinct from p_expected_revision and not (
   (select count(*) from public.branches where organization_id=p_organization_id and active)=1
   and p_expected_revision=(select revision from public.planner_state where organization_id=p_organization_id and id=true)
  ) then raise exception 'Branch revision conflict' using errcode='40001'; end if;
  if p_restore then
   select coalesce(jsonb_agg(bc.shift_date order by bc.shift_date),'[]'::jsonb) into conflicts from public.request_shift_changes bc
   left join public.shifts s on s.organization_id=bc.organization_id and s.id=bc.employee_id||'|'||bc.shift_date::text
   where bc.organization_id=p_organization_id and bc.request_id=r.id and (s.source_request_id is distinct from r.id
    or (to_jsonb(s)-array['created_at','updated_at']) is distinct from (bc.applied_shift-array['created_at','updated_at'])
    or exists(select 1 from public.attendance_variations v where v.organization_id=p_organization_id and v.shift_id=s.id));
   if jsonb_array_length(conflicts)>0 then return jsonb_build_object('ok',false,'code','restoration_conflict','dates',conflicts,'request',to_jsonb(r)); end if;
   for b in select * from public.request_shift_changes where organization_id=p_organization_id and request_id=r.id order by shift_date loop
    delete from public.shifts where organization_id=p_organization_id and id=b.employee_id||'|'||b.shift_date::text;
    if b.previous_shift is not null then insert into public.shifts select (jsonb_populate_record(null::public.shifts,b.previous_shift||jsonb_build_object('source_request_id',null))).*; end if;
    if b.previous_variation is not null then insert into public.attendance_variations select (jsonb_populate_record(null::public.attendance_variations,b.previous_variation)).*; end if;
   end loop;update public.request_shift_changes set restored_at=now() where organization_id=p_organization_id and request_id=r.id;
  else update public.shifts set source_request_id=null where organization_id=p_organization_id and source_request_id=r.id;end if;
  perform planner_private.bump_revision(p_organization_id);current_revision:=planner_private.bump_branch_revision(p_organization_id,r.approval_branch_id);
 end if;
 update public.requests set status='revoked',revoked_by_user_id=auth.uid(),revoked_at=now(),revocation_note=p_note,
  restoration=case when coalesce(r.approved_type,r.type)='Ferie' then case when p_restore then 'restored' else 'kept' end else null end,
  version=version+1,updated_at=now() where id=r.id returning * into r;perform planner_private.request_event(r,'revoked');
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',current_revision);
end $$;

-- Ensure approved cross-site shifts invalidate the destination branch only.
create or replace function public.cross_branch_shift_decide(p_organization_id uuid,p_request_id uuid,p_approve boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.cross_branch_shift_requests; s public.shifts; sid text;
begin
 if p_approve is null or p_note is null or length(p_note)>2000 then raise exception 'Invalid decision'; end if;
 select * into r from public.cross_branch_shift_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found or r.status<>'pending' then raise exception 'Pending cross-branch request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.destination_branch_id,true);
 update public.cross_branch_shift_requests set status=case when p_approve then 'approved' else 'rejected' end,
  decided_by=auth.uid(),decided_at=now(),decision_note=p_note where id=r.id returning * into r;
 if p_approve then
  sid:=r.employee_id||'|'||r.shift_date::text;
  if exists(select 1 from public.shifts where organization_id=p_organization_id and id=sid) then raise exception 'Employee already has a shift on this date'; end if;
  insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id)
  values(r.organization_id,sid,r.employee_id,r.shift_date,r.shift_type,r.start_time,r.end_time,r.destination_branch_id) returning * into s;
  perform planner_private.bump_branch_revision(p_organization_id,r.destination_branch_id);
 end if;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason,details)
 values(p_organization_id,r.destination_branch_id,auth.uid(),case when p_approve then 'cross_branch_approved' else 'cross_branch_rejected' end,
  p_note,jsonb_build_object('request_id',r.id,'employee_id',r.employee_id,'date',r.shift_date));
 return jsonb_build_object('request',to_jsonb(r),'shift',case when s.id is null then null else to_jsonb(s) end);
end $$;

revoke all on function planner_private.ensure_branch_state(uuid,uuid),planner_private.bump_branch_revision(uuid,uuid),
 planner_private.branch_state_after_insert() from public,anon,authenticated;
revoke all on function public.organization_onboard(text,text,text),public.planner_load_scoped(uuid,uuid[]),
 public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]),public.cross_branch_shift_list(uuid),
 public.branch_access_overview(uuid),public.branch_member_update(uuid,uuid,uuid,text,text,text,boolean),
 public.access_invite_list(uuid),public.access_invite_revoke(uuid,uuid) from public,anon;
grant execute on function public.organization_onboard(text,text,text),public.planner_load_scoped(uuid,uuid[]),
 public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]),public.cross_branch_shift_list(uuid),
 public.branch_access_overview(uuid),public.branch_member_update(uuid,uuid,uuid,text,text,text,boolean),
 public.access_invite_list(uuid),public.access_invite_revoke(uuid,uuid) to authenticated;

commit;
