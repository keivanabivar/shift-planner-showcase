-- Per-Sede user templates and immutable assignment snapshots.
-- Apply once after 027, only after backup/rehearsal and explicit deployment approval.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

create table public.shift_templates(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 id uuid not null default gen_random_uuid(), branch_id uuid not null,
 name text not null, start_time time not null, end_time time not null, color text not null,
 legacy_preset_id text, deleted_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(organization_id,id),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete cascade,
 check(name=trim(name) and length(name) between 1 and 100 and lower(name) not in ('riposo','malattia','ferie')),
 check(start_time<>end_time and extract(second from start_time)=0 and extract(second from end_time)=0),
 check(color ~ '^#[0-9a-fA-F]{6}$')
);
create index shift_templates_branch on public.shift_templates(organization_id,branch_id) where deleted_at is null;
create unique index shift_templates_legacy on public.shift_templates(organization_id,branch_id,legacy_preset_id) where legacy_preset_id is not null;
-- Snapshot IDs deliberately have NO FK to templates. Delete never cascades to shifts.
alter table public.shifts drop constraint shifts_type_or_custom;
alter table public.shifts add constraint shifts_type_or_custom check(
 (type in ('Riposo','Malattia','Ferie') and preset_id is null and preset_name is null and preset_color is null)
 or (type not in ('Riposo','Malattia','Ferie') and
 ((preset_id is null and preset_name is null and preset_color is null)
 or (preset_id is not null and length(preset_id)>0 and preset_name is not null and preset_name=type and length(trim(preset_name)) between 1 and 100 and preset_color is not null and preset_color ~ '^#[0-9a-fA-F]{6}$')))
);
alter table public.cross_branch_shift_requests add column preset_id text,add column preset_name text,add column preset_color text;
alter table public.cross_branch_shift_requests add constraint cross_branch_snapshot_valid check(
 (preset_id is null and preset_name is null and preset_color is null)
 or (shift_type not in ('Riposo','Malattia','Ferie') and preset_id is not null and length(preset_id)>0 and preset_name is not null and preset_name=shift_type and preset_color is not null and preset_color ~ '^#[0-9a-fA-F]{6}$')
);
-- Known colors frozen from stored organization settings, NOT invented assignment history.
create table public.legacy_work_shift_colors(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 type text not null,color text not null check(color ~ '^#[0-9a-fA-F]{6}$'),
 primary key(organization_id,type)
);
insert into public.legacy_work_shift_colors(organization_id,type,color)
 select s.organization_id,c.key,c.value from public.settings s cross join lateral jsonb_each_text(coalesce(s.value->'colors','{}')) c
 where c.key not in ('Riposo','Malattia','Ferie') and c.value ~ '^#[0-9a-fA-F]{6}$';
-- Copy only user-created presets. Every Sede owns a separate ID, including inactive Sedi.
insert into public.shift_templates(organization_id,branch_id,name,start_time,end_time,color,legacy_preset_id)
 select b.organization_id,b.id,p->>'name',(p->>'start')::time,(p->>'end')::time,p->>'color',p->>'id'
 from public.branches b join public.settings s on s.organization_id=b.organization_id
 cross join lateral jsonb_array_elements(coalesce(s.value#>'{presets,custom}','[]')) p;
-- No UPDATE/DELETE of shifts, variations, archives, requests or request history.
alter table public.shift_templates enable row level security;
alter table public.legacy_work_shift_colors enable row level security;
revoke all on public.shift_templates,public.legacy_work_shift_colors from public,anon,authenticated;
grant select on public.shift_templates,public.legacy_work_shift_colors to authenticated;
create function planner_private.can_read_template_branch(p_oid uuid,p_bid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select p_oid=public.current_organization_id() and exists(select 1 from public.branches b where b.organization_id=p_oid and b.id=p_bid and b.active) and (
 planner_private.can_operate_branch(p_oid,p_bid,false) or exists(select 1 from public.profiles p where p.user_id=auth.uid() and p.organization_id=p_oid and p.is_active and p.role='viewer' and
 ((p.employee_id is not null and p.visibility_level in ('own','home_branch') and exists(select 1 from public.employee_branch_assignments a where a.organization_id=p_oid and a.employee_id=p.employee_id and a.branch_id=p_bid))
 or (p.visibility_level='all_branches' and exists(select 1 from public.user_branch_assignments a where a.organization_id=p_oid and a.user_id=p.user_id and a.branch_id=p_bid))))
 );
$$;
revoke all on function planner_private.can_read_template_branch(uuid,uuid) from public,anon;
grant execute on function planner_private.can_read_template_branch(uuid,uuid) to authenticated;
create policy template_scope_read on public.shift_templates for select to authenticated using(
 organization_id=public.current_organization_id() and planner_private.can_read_template_branch(organization_id,branch_id)
);
create policy legacy_color_read on public.legacy_work_shift_colors for select to authenticated using(organization_id=public.current_organization_id());

-- Legacy documents remain valid while v2 has only statuses and optional user templates.
alter function public.planner_valid_settings(jsonb) rename to planner_valid_settings_027;
create function public.planner_valid_settings(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare p jsonb; t text;
begin
 if v->>'version' is distinct from '2' then return public.planner_valid_settings_027(v); end if;
 if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v#>'{presets,custom}') is distinct from 'array' then return false; end if;
 foreach t in array array['Riposo','Malattia','Ferie'] loop
  if coalesce(v->'colors'->>t,'') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
 end loop;
 for p in select value from jsonb_array_elements(v#>'{presets,custom}') loop
  if coalesce(p->>'id','')='' or coalesce(p->>'branchId','')='' or coalesce(length(trim(p->>'name')),0) not between 1 and 100
   or lower(trim(p->>'name')) in ('riposo','malattia','ferie')
   or coalesce(p->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   or p->>'start'=p->>'end' or coalesce(p->>'color','') !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
 end loop;
 return not exists(select 1 from jsonb_array_elements(v#>'{presets,custom}') item group by item->>'id' having count(*)>1);
end $$;
alter table public.settings drop constraint settings_valid;
alter table public.settings add constraint settings_valid check(public.planner_valid_settings(value));
revoke all on function public.planner_valid_settings_027(jsonb),public.planner_valid_settings(jsonb) from public,anon,authenticated;

create function planner_private.template_write(p_oid uuid,p_op jsonb) returns void language plpgsql security definer set search_path='' as $$
declare bid uuid:=(p_op->>'branchId')::uuid; tid uuid:=(p_op->>'id')::uuid;
begin
 perform planner_private.lock_branch_operator(p_oid,bid,false);
 if exists(select 1 from public.shift_templates where organization_id=p_oid and id=tid and (branch_id<>bid or deleted_at is not null)) then raise exception 'Template unavailable in this branch' using errcode='42501'; end if;
 if p_op->>'kind'='template_delete' then
  update public.shift_templates set deleted_at=now(),updated_at=now() where organization_id=p_oid and id=tid and branch_id=bid;
 else
  if coalesce(p_op->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_op->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid template time'; end if;
  insert into public.shift_templates(organization_id,id,branch_id,name,start_time,end_time,color)
   values(p_oid,tid,bid,p_op->>'name',(p_op->>'start')::time,(p_op->>'end')::time,p_op->>'color')
   on conflict(organization_id,id) do update set name=excluded.name,start_time=excluded.start_time,end_time=excluded.end_time,color=excluded.color,updated_at=now();
 end if;
end $$;
revoke all on function planner_private.template_write(uuid,jsonb) from public,anon,authenticated;

alter function public.planner_load_scoped(uuid,uuid[]) rename to planner_load_scoped_027;
revoke all on function public.planner_load_scoped_027(uuid,uuid[]) from public,anon,authenticated;
create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; selected uuid[]; previous jsonb; colors jsonb; templates jsonb;
begin
 result:=public.planner_load_scoped_027(p_organization_id,p_branch_ids);
 select coalesce(array_agg(x::uuid),'{}') into selected from jsonb_array_elements_text(result->'selected_branch_ids') x;
 result:=result||jsonb_build_object('organization_revision',(select revision from public.planner_state where organization_id=p_organization_id and id=true));
 previous:=result#>'{snapshot,settings}';
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'branchId',branch_id,'name',name,'start',to_char(start_time,'HH24:MI'),'end',to_char(end_time,'HH24:MI'),'color',color) order by created_at,id),'[]') into templates
  from public.shift_templates where organization_id=p_organization_id and branch_id=any(selected) and deleted_at is null;
 select coalesce(jsonb_object_agg(type,color),'{}') into colors from public.legacy_work_shift_colors where organization_id=p_organization_id;
 return jsonb_set(result,'{snapshot,settings}',jsonb_build_object('version',2,'presets',jsonb_build_object('custom',templates),
  'colors',jsonb_build_object('Riposo',coalesce(previous#>>'{colors,Riposo}','#D84A4A'),'Malattia',coalesce(previous#>>'{colors,Malattia}','#E6C65C'),'Ferie',coalesce(previous#>>'{colors,Ferie}','#B8C4D1')),'legacyColors',colors));
end $$;
create or replace function public.planner_load() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; oid uuid:=public.current_organization_id();
begin result:=public.planner_load_scoped(oid,null);return jsonb_set(result,'{revision}',to_jsonb((select revision from public.planner_state where organization_id=oid and id=true)));end $$;

alter function public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]) rename to planner_apply_branch_operations_027;
revoke all on function public.planner_apply_branch_operations_027(uuid,jsonb,jsonb,uuid[]) from public,anon,authenticated;
create function public.planner_apply_branch_operations(p_organization_id uuid,p_operations jsonb,p_expected_revisions jsonb,p_branch_ids uuid[] default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare op jsonb; bid uuid; rev bigint; rest jsonb; touched uuid[]:='{}'; result jsonb;
begin
 perform planner_private.lock_member(p_organization_id);
 if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations)>5000 or jsonb_typeof(p_expected_revisions) is distinct from 'object' then raise exception 'Invalid operation payload'; end if;
 for bid in select distinct (v->>'branchId')::uuid from jsonb_array_elements(p_operations) v loop
  perform planner_private.lock_branch_operator(p_organization_id,bid,false);
  perform planner_private.ensure_branch_state(p_organization_id,bid);
  select revision into rev from public.branch_planner_state where organization_id=p_organization_id and branch_id=bid for update;
  if not(p_expected_revisions ? bid::text) or rev is distinct from (p_expected_revisions->>bid::text)::bigint then raise exception 'Branch revision conflict' using errcode='40001'; end if;
 end loop;
 for op in select value from jsonb_array_elements(p_operations) loop
  if op->>'kind'='settings_update' then raise exception 'Use Sede template operations' using errcode='42501'; end if;
  if op->>'kind' in ('template_upsert','template_delete') then
   perform planner_private.template_write(p_organization_id,op);touched:=array_append(touched,(op->>'branchId')::uuid);
  elsif op->>'kind'='shift_upsert' then
   if coalesce(length(trim(op->>'type')),0) not between 1 and 100 then raise exception 'Invalid shift name'; end if;
   if op->>'type' not in ('Riposo','Malattia','Ferie') and (coalesce(op->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(op->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or op->>'start'=op->>'end') then raise exception 'Invalid shift time'; end if;
   if op->>'id' is distinct from (op->>'employeeId')||'|'||(op->>'date') then raise exception 'Invalid shift key'; end if;
  end if;
 end loop;
 select coalesce(jsonb_agg(v),'[]') into rest from jsonb_array_elements(p_operations) v where v->>'kind' not in ('template_upsert','template_delete');
 result:=public.planner_apply_branch_operations_027(p_organization_id,rest,p_expected_revisions,null);
 for bid in select distinct x from unnest(touched) x loop
  if not exists(select 1 from jsonb_array_elements(rest) v where v->>'branchId'=bid::text) then perform planner_private.bump_branch_revision(p_organization_id,bid); end if;
 end loop;
 if jsonb_array_length(p_operations)>0 then perform planner_private.bump_revision(p_organization_id); end if;
 return public.planner_load_scoped(p_organization_id,p_branch_ids);
end $$;
-- BEGIN SINGLE-SEDE BULK DELETE
-- A separate endpoint binds the complete destructive request to exactly one Sede.
-- Validate and lock every requested shift before delegating to the existing scoped
-- deletion path, which retains archive guards and FK cascades for variations.
create or replace function public.planner_bulk_delete_shifts(p_organization_id uuid,p_branch_id uuid,p_shift_ids text[],p_expected_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sid text; stored_branch uuid; rev bigint; ops jsonb;
begin
 if p_branch_id is null or p_expected_revision is null or p_shift_ids is null
 or cardinality(p_shift_ids) not between 1 and 5000 or array_ndims(p_shift_ids) is distinct from 1
 or exists(select 1 from unnest(p_shift_ids) x where x is null or trim(x)='')
 or (select count(distinct x) from unnest(p_shift_ids) x)<>cardinality(p_shift_ids) then
  raise exception 'Select exactly one Sede and a nonempty shift selection' using errcode='22023';
 end if;
 perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,false);
 perform planner_private.ensure_branch_state(p_organization_id,p_branch_id);
 select revision into rev from public.branch_planner_state where organization_id=p_organization_id and branch_id=p_branch_id for update;
 if rev is distinct from p_expected_revision then raise exception 'Branch revision conflict' using errcode='40001'; end if;
 for sid in select x from unnest(p_shift_ids) x order by x loop
  select branch_id into stored_branch from public.shifts where organization_id=p_organization_id and id=sid for update;
  if not found then raise exception 'Shift selection changed' using errcode='40001'; end if;
  if stored_branch is distinct from p_branch_id then raise exception 'Shift outside selected Sede' using errcode='42501'; end if;
 end loop;
 select jsonb_agg(jsonb_build_object('kind','shift_delete','id',x,'branchId',p_branch_id)) into ops from unnest(p_shift_ids) x;
 return public.planner_apply_branch_operations(p_organization_id,ops,jsonb_build_object(p_branch_id::text,p_expected_revision),null);
end $$;
revoke all on function public.planner_bulk_delete_shifts(uuid,uuid,text[],bigint) from public,anon;
grant execute on function public.planner_bulk_delete_shifts(uuid,uuid,text[],bigint) to authenticated;
-- END SINGLE-SEDE BULK DELETE

create or replace function public.planner_save(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); current_revision bigint; k text; v jsonb; preset jsonb; bid uuid; revisions jsonb;
begin
 if auth.uid() is null or oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform planner_private.lock_member(oid,'writer');
 -- Browser context is only a precondition, never an authority: prevents stale
 -- requests writing into a new membership if an administrator moves a user.
 if payload->>'expected_organization_id' is distinct from oid::text then raise exception 'Organization changed' using errcode='42501'; end if;
 -- The browser never chooses the target organization. Reject explicit spoofing.
 if payload ? 'organization_id' or payload ? 'organizationId' then raise exception 'Organization is server-derived' using errcode='42501'; end if;
 select revision into current_revision from public.planner_state where organization_id=oid and id=true for update;
 if expected_revision is null or current_revision is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if only_empty is null then raise exception 'Invalid import mode'; end if;
 -- A whole-snapshot import also compares EVERY operational Sede revision.
 -- Organization revision alone cannot detect request/cross-Sede branch writes.
 if not only_empty then
  if jsonb_typeof(payload->'expected_branch_revisions') is distinct from 'object' then raise exception 'Branch revisions required' using errcode='40001'; end if;
  for bid in select id from public.branches where organization_id=oid and active loop
   perform planner_private.lock_branch_operator(oid,bid,false);
   if not(payload->'expected_branch_revisions' ? bid::text) or (payload->'expected_branch_revisions'->>bid::text)::bigint is distinct from (select revision from public.branch_planner_state where organization_id=oid and branch_id=bid) then raise exception 'Branch revision conflict' using errcode='40001'; end if;
  end loop;
 end if;
 if only_empty and (exists(select 1 from public.employees where organization_id=oid) or exists(select 1 from public.settings where organization_id=oid) or exists(select 1 from public.notes where organization_id=oid)) then raise exception 'Organization not empty' using errcode='40001'; end if;
 if payload->'data'->>'version' is distinct from '1' or not public.planner_valid_settings(payload->'settings')
 or jsonb_typeof(payload->'data'->'employees') is distinct from 'array' or jsonb_typeof(payload->'notes') is distinct from 'array'
 or jsonb_typeof(payload->'data'->'shifts') is distinct from 'object' or jsonb_typeof(payload->'variations') is distinct from 'object' then raise exception 'Invalid payload'; end if;

 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  if jsonb_typeof(v) is distinct from 'object' or nullif(trim(v->>'type'),'') is null then raise exception 'Invalid shift'; end if;
  if v ? 'source_request_id' or v ? 'sourceRequestId' or v ? 'organization_id' then raise exception 'Server-managed shift field'; end if;
  if v->>'type' in ('Riposo','Malattia','Ferie') then
   if v->>'start' is not null or v->>'end' is not null then raise exception 'Off-day times must be null'; end if;
  elsif coalesce(v->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(v->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'start'=v->>'end' then raise exception 'Invalid shift time'; end if;
  if v ? 'presetId' or v ? 'presetName' or v ? 'presetColor' then
   if v->>'type' in ('Riposo','Malattia','Ferie') or coalesce(v->>'presetId','')='' or v->>'type' is distinct from v->>'presetName' or coalesce(v->>'presetColor','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid shift snapshot'; end if;
  end if;
 if not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=left(k,length(k)-11)) then raise exception 'Orphan shift'; end if;
 end loop;
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  bid:=coalesce((v->>'branchId')::uuid,(select home_branch_id from public.employees where organization_id=oid and id=left(k,length(k)-11)),(select id from public.branches where organization_id=oid and active order by created_at,id limit 1));
  perform planner_private.lock_branch_operator(oid,bid,false);
  if exists(select 1 from public.shifts where organization_id=oid and id=k and branch_id<>bid) then raise exception 'Shift belongs to another branch' using errcode='42501'; end if;
 end loop;
 for k,v in select key,value from jsonb_each(payload->'variations') loop
 if k is distinct from (v->>'employeeId')||'|'||(v->>'date') or not (payload->'data'->'shifts' ? k) then raise exception 'Orphan variation'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(payload->'notes') n where coalesce(n->>'employeeId','')<>'' and not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=n->>'employeeId')) then raise exception 'Orphan note'; end if;
 for v in select value from jsonb_array_elements(payload->'data'->'employees') loop
  bid:=coalesce((v->>'homeBranchId')::uuid,(select home_branch_id from public.employees where organization_id=oid and id=v->>'id'),(select id from public.branches where organization_id=oid and active order by created_at,id limit 1));
  perform planner_private.lock_branch_operator(oid,bid,false);
 end loop;
 insert into public.employees(organization_id,id,name,position,home_branch_id)
 select oid,e->>'id',e->>'name',ord,coalesce((e->>'homeBranchId')::uuid,(select id from public.branches where organization_id=oid and active order by created_at,id limit 1)) from jsonb_array_elements(payload->'data'->'employees') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set name=excluded.name,position=excluded.position,updated_at=now();
 delete from public.attendance_variations where organization_id=oid and shift_id in(select id from public.shifts where organization_id=oid and branch_id in(select id from public.branches where organization_id=oid and active)) and id not in(select key from jsonb_each(payload->'variations'));
 delete from public.shifts where organization_id=oid and branch_id in(select id from public.branches where organization_id=oid and active) and id not in(select key from jsonb_each(payload->'data'->'shifts'));
 insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,preset_id,preset_name,preset_color,branch_id)
 select oid,key,left(key,length(key)-11),right(key,10)::date,value->>'type',(value->>'start')::time,(value->>'end')::time,value->>'presetId',value->>'presetName',upper(value->>'presetColor'),coalesce((value->>'branchId')::uuid,(select home_branch_id from public.employees where organization_id=oid and id=left(key,length(key)-11))) from jsonb_each(payload->'data'->'shifts')
 on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,end_time=excluded.end_time,preset_id=excluded.preset_id,preset_name=excluded.preset_name,preset_color=excluded.preset_color,updated_at=now();
 insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note)
 select oid,key,key,(value->>'start')::time,(value->>'end')::time,value->>'reason',value->>'customReason',value->>'note' from jsonb_each(payload->'variations')
 on conflict(organization_id,id) do update set actual_start_time=excluded.actual_start_time,actual_end_time=excluded.actual_end_time,reason=excluded.reason,custom_reason=excluded.custom_reason,note=excluded.note,updated_at=now();
 if exists(select 1 from public.attendance_variations v join public.shifts s on s.organization_id=v.organization_id and s.id=v.shift_id where v.organization_id=oid and s.type in ('Riposo','Malattia','Ferie')) then raise exception 'Invalid variation'; end if;
 delete from public.notes where organization_id=oid and (branch_id is null or branch_id in(select id from public.branches where organization_id=oid and active)) and id not in(select e->>'id' from jsonb_array_elements(payload->'notes') e);
 for v in select value from jsonb_array_elements(payload->'notes') loop
  bid:=nullif(v->>'branchId','')::uuid;
  if bid is not null then perform planner_private.lock_branch_operator(oid,bid,false); end if;
  if exists(select 1 from public.notes where organization_id=oid and id=v->>'id' and branch_id is distinct from bid) then raise exception 'Note belongs to another branch' using errcode='42501'; end if;
 end loop;
 insert into public.notes(organization_id,id,text,date,employee_id,position,branch_id)
 select oid,e->>'id',e->>'text',nullif(e->>'date','')::date,nullif(e->>'employeeId',''),ord,nullif(e->>'branchId','')::uuid from jsonb_array_elements(payload->'notes') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set text=excluded.text,date=excluded.date,employee_id=excluded.employee_id,position=excluded.position,updated_at=now();
 delete from public.employees where organization_id=oid and home_branch_id in(select id from public.branches where organization_id=oid and active) and id not in(select e->>'id' from jsonb_array_elements(payload->'data'->'employees') e);
 if payload#>>'{settings,version}'='2' then
  for preset in select value from jsonb_array_elements(payload#>'{settings,presets,custom}') loop
   perform planner_private.template_write(oid,preset||jsonb_build_object('kind','template_upsert'));
  end loop;
  update public.shift_templates set deleted_at=now(),updated_at=now() where organization_id=oid and branch_id in(select id from public.branches where organization_id=oid and active) and deleted_at is null and id::text not in(select p->>'id' from jsonb_array_elements(payload#>'{settings,presets,custom}') p);
 end if;
 insert into public.settings(organization_id,id,value) values(oid,true,case when payload#>>'{settings,version}'='2' then jsonb_set(payload->'settings','{presets,custom}','[]')-'legacyColors' else payload->'settings' end) on conflict(organization_id,id) do update set value=excluded.value,updated_at=now();
 update public.planner_state set revision=revision+1 where organization_id=oid and id=true;
 perform planner_private.bump_branch_revision(oid,id) from public.branches where organization_id=oid and active;
 return public.planner_load();
end $$;

-- Compatibility entry point: no effective date and no template substitution.
create or replace function public.planner_save_effective(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); changed_notes text[]; result jsonb;
begin
 perform planner_private.lock_member(oid,'writer');
 select coalesce(array_agg(n->>'id'),'{}') into changed_notes from jsonb_array_elements(payload->'notes') n
 left join public.notes old on old.organization_id=oid and old.id=n->>'id'
 where old.id is null or old.text is distinct from n->>'text' or old.date is distinct from (n->>'date')::date or coalesce(old.employee_id,'') is distinct from coalesce(n->>'employeeId','');
 result:=public.planner_save(payload,expected_revision,only_empty);
 update public.notes set updated_by_user_id=auth.uid() where organization_id=oid and id=any(changed_notes);
 return public.planner_load();
end $$;
-- A historical request reversal need not match today's templates.
create or replace function planner_private.restore_preset_compatible(p_oid uuid,p_shift jsonb) returns boolean language sql stable security definer set search_path='' as $$select true$$;
alter function public.cross_branch_shift_propose(uuid,text,uuid,date,text,time,time) rename to cross_branch_shift_propose_027;
revoke all on function public.cross_branch_shift_propose_027(uuid,text,uuid,date,text,time,time) from public,anon,authenticated;
create or replace function public.cross_branch_shift_propose(p_organization_id uuid,p_employee_id text,p_destination_branch_id uuid,
 p_date date,p_type text,p_start time default null,p_end time default null,p_preset_id text default null,p_preset_name text default null,p_preset_color text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare home uuid; r public.cross_branch_shift_requests;
begin
 select home_branch_id into home from public.employees where organization_id=p_organization_id and id=p_employee_id;
 if home is null or home=p_destination_branch_id then raise exception 'Invalid cross-branch assignment'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,home,true);
 perform 1 from public.branches where organization_id=p_organization_id and id=p_destination_branch_id and active;
 if not found then raise exception 'Destination branch not found'; end if;
 if exists(select 1 from public.shifts where organization_id=p_organization_id and employee_id=p_employee_id and date=p_date)
 then raise exception 'Employee already has a shift on this date'; end if;
 insert into public.cross_branch_shift_requests(organization_id,employee_id,home_branch_id,destination_branch_id,
  shift_date,shift_type,start_time,end_time,proposed_by,preset_id,preset_name,preset_color)
 values(p_organization_id,p_employee_id,home,p_destination_branch_id,p_date,p_type,p_start,p_end,auth.uid(),p_preset_id,p_preset_name,p_preset_color) returning * into r;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
 values(p_organization_id,p_destination_branch_id,auth.uid(),'cross_branch_proposed',jsonb_build_object('request_id',r.id,'employee_id',p_employee_id,'home_branch_id',home,'date',p_date));
 return to_jsonb(r);
end $$;

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
  insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id,preset_id,preset_name,preset_color)
  values(r.organization_id,sid,r.employee_id,r.shift_date,r.shift_type,r.start_time,r.end_time,r.destination_branch_id,r.preset_id,r.preset_name,r.preset_color) returning * into s;
  perform planner_private.bump_branch_revision(p_organization_id,r.destination_branch_id);
 end if;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason,details)
 values(p_organization_id,r.destination_branch_id,auth.uid(),case when p_approve then 'cross_branch_approved' else 'cross_branch_rejected' end,
  p_note,jsonb_build_object('request_id',r.id,'employee_id',r.employee_id,'date',r.shift_date));
 return jsonb_build_object('request',to_jsonb(r),'shift',case when s.id is null then null else to_jsonb(s) end);
end $$;

revoke all on function public.planner_load(),public.planner_load_scoped(uuid,uuid[]),public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]),public.planner_save(jsonb,bigint,boolean),public.planner_save_effective(jsonb,bigint,boolean),public.cross_branch_shift_propose(uuid,text,uuid,date,text,time,time,text,text,text) from public,anon;
grant execute on function public.planner_load(),public.planner_load_scoped(uuid,uuid[]),public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]),public.planner_save(jsonb,bigint,boolean),public.planner_save_effective(jsonb,bigint,boolean),public.cross_branch_shift_propose(uuid,text,uuid,date,text,time,time,text,text,text) to authenticated;
commit;
