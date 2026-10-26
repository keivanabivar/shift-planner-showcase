-- Branch assignment has one administrative source: Utenti e accessi.
-- home_branch_id remains as a derived compatibility value for legacy RPCs and
-- request ownership; it is no longer independently editable by the client.

create table public.employee_branch_assignments(
 organization_id uuid not null,
 employee_id text not null,
 branch_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,employee_id,branch_id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete cascade,
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict
);
create index employee_branch_assignments_branch on public.employee_branch_assignments(organization_id,branch_id,employee_id);
insert into public.employee_branch_assignments(organization_id,employee_id,branch_id)
select organization_id,id,home_branch_id from public.employees;

create function planner_private.employee_default_branch_assignment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.employee_branch_assignments(organization_id,employee_id,branch_id)
 values(new.organization_id,new.id,new.home_branch_id) on conflict do nothing;
 return new;
end $$;
create trigger employee_default_branch_assignment after insert on public.employees
for each row execute function planner_private.employee_default_branch_assignment();

create table public.user_branch_assignments(
 organization_id uuid not null,
 user_id uuid not null,
 branch_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,user_id,branch_id),
 foreign key(user_id) references public.profiles(user_id) on delete cascade,
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict
);
create index user_branch_assignments_branch on public.user_branch_assignments(organization_id,branch_id,user_id);
insert into public.user_branch_assignments(organization_id,user_id,branch_id)
select distinct i.organization_id,i.accepted_by,i.target_branch_id
from public.organization_invitations i
where i.accepted_by is not null and i.accepted_at is not null and i.target_branch_id is not null
on conflict do nothing;

alter table public.employee_branch_assignments enable row level security;
alter table public.user_branch_assignments enable row level security;
revoke all on public.employee_branch_assignments,public.user_branch_assignments from public,anon,authenticated;

create function public.employee_branch_assignment_overview(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then raise exception 'Access denied' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'organization_id',e.organization_id,'employee_id',e.id,'employee_name',e.name,
  'user_id',(select p.user_id from public.profiles p where p.organization_id=e.organization_id and p.employee_id=e.id limit 1),
  'branch_ids',coalesce((select jsonb_agg(a.branch_id order by b.created_at,b.id) from public.employee_branch_assignments a
    join public.branches b on b.organization_id=a.organization_id and b.id=a.branch_id
    where a.organization_id=e.organization_id and a.employee_id=e.id),'[]'::jsonb)
 ) order by e.position,e.id) from public.employees e where e.organization_id=p_organization_id),'[]'::jsonb);
end $$;

create function public.employee_branch_assignment_update(p_organization_id uuid,p_employee_id text,p_branch_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; bid uuid; primary_bid uuid;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then raise exception 'Access denied' using errcode='42501'; end if;
 if coalesce(cardinality(p_branch_ids),0)=0 or cardinality(p_branch_ids)<>cardinality(array(select distinct x from unnest(p_branch_ids) x)) then raise exception 'At least one unique branch is required'; end if;
 if not exists(select 1 from public.employees where organization_id=p_organization_id and id=p_employee_id) then raise exception 'Employee not found'; end if;
 foreach bid in array p_branch_ids loop
  if not exists(select 1 from public.branches where organization_id=p_organization_id and id=bid and active) then raise exception 'Invalid branch'; end if;
  if actor.organization_role<>'owner' and not planner_private.can_operate_branch(p_organization_id,bid,true) then raise exception 'Branch access denied' using errcode='42501'; end if;
 end loop;
 if actor.organization_role<>'owner' and exists(select 1 from public.employee_branch_assignments a where a.organization_id=p_organization_id and a.employee_id=p_employee_id and not planner_private.can_operate_branch(p_organization_id,a.branch_id,true)) then raise exception 'Branch access denied' using errcode='42501'; end if;
 delete from public.employee_branch_assignments where organization_id=p_organization_id and employee_id=p_employee_id and not(branch_id=any(p_branch_ids));
 insert into public.employee_branch_assignments(organization_id,employee_id,branch_id) select p_organization_id,p_employee_id,x from unnest(p_branch_ids) x on conflict do nothing;
 select b.id into primary_bid from public.branches b where b.organization_id=p_organization_id and b.id=any(p_branch_ids) order by b.created_at,b.id limit 1;
 update public.employees set home_branch_id=primary_bid,updated_at=now() where organization_id=p_organization_id and id=p_employee_id;
 return jsonb_build_object('organization_id',p_organization_id,'employee_id',p_employee_id,'branch_ids',to_jsonb(p_branch_ids));
end $$;

create function public.branch_member_assignments_update(p_organization_id uuid,p_user_id uuid,p_role text,p_employee_id text,
 p_visibility_level text,p_is_active boolean,p_branch_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; bid uuid; first_bid uuid; result jsonb;
begin
 actor:=planner_private.lock_member(p_organization_id);
 if actor.organization_role<>'owner' and not exists(select 1 from public.branch_memberships bm where bm.organization_id=p_organization_id and bm.user_id=actor.user_id and bm.role='branch_admin' and bm.is_active) then raise exception 'Access denied' using errcode='42501'; end if;
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
  'role',case when exists(select 1 from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.role='branch_admin' and bm.is_active) then 'branch_admin'
              when exists(select 1 from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.role='editor' and bm.is_active) then 'editor'
              when p.employee_id is not null then 'employee' else 'viewer' end,
  'branch_id',(select x.branch_id from (select uba.branch_id from public.user_branch_assignments uba where uba.organization_id=p.organization_id and uba.user_id=p.user_id union select bm.branch_id from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.is_active union select i.target_branch_id from public.organization_invitations i where i.organization_id=p.organization_id and i.accepted_by=p.user_id and i.accepted_at is not null and i.target_branch_id is not null) x order by x.branch_id limit 1),
  'branch_ids',coalesce((select jsonb_agg(x.branch_id order by x.branch_id) from (
    select uba.branch_id from public.user_branch_assignments uba where uba.organization_id=p.organization_id and uba.user_id=p.user_id
    union select bm.branch_id from public.branch_memberships bm where bm.organization_id=p.organization_id and bm.user_id=p.user_id and bm.is_active
    union select i.target_branch_id from public.organization_invitations i where i.organization_id=p.organization_id and i.accepted_by=p.user_id and i.accepted_at is not null and i.target_branch_id is not null
   ) x),'[]'::jsonb)
 ) order by p.created_at,p.user_id) from public.profiles p where p.organization_id=p_organization_id),'[]'::jsonb);
end $$;

alter function public.planner_load_scoped(uuid,uuid[]) rename to planner_load_scoped_020;
create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; authorized uuid[]; selected uuid[]; raw jsonb; own_only boolean;
begin
 m:=planner_private.lock_member(p_organization_id);own_only:=m.role='viewer' and m.visibility_level='own';
 if m.role<>'viewer' then
  select array_agg(b.id order by b.created_at,b.id) into authorized from public.branches b where b.organization_id=p_organization_id and b.active and planner_private.can_operate_branch(p_organization_id,b.id,false);
 elsif m.employee_id is not null and m.visibility_level in ('own','home_branch') then
  select array_agg(a.branch_id order by b.created_at,b.id) into authorized from public.employee_branch_assignments a join public.branches b on b.organization_id=a.organization_id and b.id=a.branch_id where a.organization_id=p_organization_id and a.employee_id=m.employee_id and b.active;
 else
  select array_agg(x.branch_id order by x.branch_id) into authorized from (
   select branch_id from public.user_branch_assignments where organization_id=p_organization_id and user_id=m.user_id
   union select target_branch_id from public.organization_invitations where organization_id=p_organization_id and accepted_by=m.user_id and accepted_at is not null and target_branch_id is not null
  ) x;
  if coalesce(cardinality(authorized),0)=0 and m.employee_id is not null then
   select array_agg(a.branch_id order by b.created_at,b.id) into authorized from public.employee_branch_assignments a join public.branches b on b.organization_id=a.organization_id and b.id=a.branch_id where a.organization_id=p_organization_id and a.employee_id=m.employee_id and b.active;
  end if;
 end if;
 authorized:=coalesce(authorized,'{}'::uuid[]);
 if own_only or p_branch_ids is null or cardinality(p_branch_ids)=0 then selected:=authorized;
 else
  if exists(select 1 from unnest(p_branch_ids) x where not(x=any(authorized))) then raise exception 'Branch scope denied' using errcode='42501'; end if;
  select array_agg(distinct x) into selected from unnest(p_branch_ids) x;
 end if;
 selected:=coalesce(selected,'{}'::uuid[]);
 raw:=public.planner_load_scoped_unfiltered(p_organization_id,null);
 raw:=jsonb_set(raw,'{selected_branch_ids}',to_jsonb(selected));
 raw:=jsonb_set(raw,'{snapshot,data,employees}',coalesce((select jsonb_agg(jsonb_set(e.value,'{branchIds}',coalesce((select jsonb_agg(a.branch_id) from public.employee_branch_assignments a where a.organization_id=p_organization_id and a.employee_id=e.value->>'id'),'[]'::jsonb)) order by e.ordinality)
  from jsonb_array_elements(raw#>'{snapshot,data,employees}') with ordinality e(value,ordinality)
  where (own_only and e.value->>'id'=m.employee_id) or (not own_only and exists(select 1 from public.employee_branch_assignments a where a.organization_id=p_organization_id and a.employee_id=e.value->>'id' and a.branch_id=any(selected)))),'[]'::jsonb));
 raw:=jsonb_set(raw,'{snapshot,data,shifts}',coalesce((select jsonb_object_agg(s.key,s.value) from jsonb_each(raw#>'{snapshot,data,shifts}') s where (s.value->>'branchId')::uuid=any(selected) and (not own_only or s.key like m.employee_id||'|%')),'{}'::jsonb));
 raw:=jsonb_set(raw,'{snapshot,variations}',coalesce((select jsonb_object_agg(v.key,v.value) from jsonb_each(coalesce(raw#>'{snapshot,variations}','{}'::jsonb)) v where (v.value->>'branchId')::uuid=any(selected) and (not own_only or v.key like m.employee_id||'|%')),'{}'::jsonb));
 raw:=jsonb_set(raw,'{snapshot,notes}',coalesce((select jsonb_agg(n.value order by n.ordinality) from jsonb_array_elements(raw#>'{snapshot,notes}') with ordinality n(value,ordinality) where nullif(n.value->>'branchId','') is null or (n.value->>'branchId')::uuid=any(selected)),'[]'::jsonb));
 raw:=jsonb_set(raw,'{branches}',coalesce((select jsonb_agg(jsonb_set(b.value,'{readable}',to_jsonb((b.value->>'id')::uuid=any(authorized))) order by b.ordinality) from jsonb_array_elements(raw->'branches') with ordinality b(value,ordinality)),'[]'::jsonb));
 raw:=jsonb_set(raw,'{empty}',to_jsonb(jsonb_array_length(raw#>'{snapshot,data,employees}')=0));
 return raw;
end $$;

create or replace function public.planner_apply_branch_operations(p_organization_id uuid,p_operations jsonb,p_expected_revisions jsonb,
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
   on conflict(organization_id,id) do update set name=excluded.name,position=excluded.position,updated_at=now();
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
   if old_bid is null and not exists(select 1 from public.employee_branch_assignments a where a.organization_id=p_organization_id and a.employee_id=employee and a.branch_id=bid) then
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

revoke all on function public.employee_branch_assignment_overview(uuid),public.employee_branch_assignment_update(uuid,text,uuid[]),public.branch_member_assignments_update(uuid,uuid,text,text,text,boolean,uuid[]),public.planner_load_scoped_020(uuid,uuid[]),public.planner_load_scoped(uuid,uuid[]) from public,anon;
grant execute on function public.employee_branch_assignment_overview(uuid),public.employee_branch_assignment_update(uuid,text,uuid[]),public.branch_member_assignments_update(uuid,uuid,text,text,text,boolean,uuid[]),public.planner_load_scoped(uuid,uuid[]) to authenticated;
