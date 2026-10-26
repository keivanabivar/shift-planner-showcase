-- Apply after 001 and 002. Preserves all records. Do not run historical public-test scripts.
begin;
lock table public.employees,public.shifts,public.attendance_variations,public.notes,public.settings,public.planner_state in access exclusive mode;
create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 200),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 full_name text not null default '' check(length(full_name)<=200),role text not null check(role in ('admin','manager')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index profiles_organization_idx on public.profiles(organization_id);
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
-- Permanently disable all historical RPC/public-test access paths.
update public.planner_access set public_test_mode=false;
create or replace function public.planner_access_allowed() returns boolean language sql stable security definer set search_path='' as $$ select false $$;
create or replace function public.planner_load_internal() returns jsonb language plpgsql security definer set search_path='' as $$
begin raise exception 'Legacy access disabled' using errcode='42501'; end $$;
create or replace function public.planner_save_internal(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
begin raise exception 'Legacy access disabled' using errcode='42501'; end $$;
revoke all on function public.planner_access_allowed(),public.planner_load_internal(),public.planner_save_internal(jsonb,bigint,boolean) from public,anon,authenticated;
alter table public.employees add column organization_id uuid references public.organizations(id);
alter table public.shifts add column organization_id uuid references public.organizations(id);
alter table public.attendance_variations add column organization_id uuid references public.organizations(id);
alter table public.notes add column organization_id uuid references public.organizations(id);
alter table public.settings add column organization_id uuid references public.organizations(id);
alter table public.planner_state add column organization_id uuid references public.organizations(id);
-- Quarantine existing data: no user is granted membership or automatic ownership.
do $$ declare archive_id uuid; begin
 insert into public.organizations(name) values('Archivio non assegnato') returning id into archive_id;
 update public.employees set organization_id=archive_id;
 update public.shifts set organization_id=archive_id;
 update public.attendance_variations set organization_id=archive_id;
 update public.notes set organization_id=archive_id;
 update public.settings set organization_id=archive_id;
 update public.planner_state set organization_id=archive_id;
end $$;
-- Composite keys preserve local IDs and forbid cross-organization references.
alter table public.attendance_variations drop constraint attendance_variations_shift_id_fkey;
alter table public.notes drop constraint notes_employee_id_fkey;
alter table public.shifts drop constraint shifts_employee_id_fkey;
alter table public.employees drop constraint employees_pkey,alter column organization_id set not null,add primary key(organization_id,id);
alter table public.shifts drop constraint shifts_pkey,drop constraint shifts_employee_id_date_key,alter column organization_id set not null,
 add primary key(organization_id,id),add unique(organization_id,employee_id,date),
 add foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete cascade;
alter table public.attendance_variations drop constraint attendance_variations_pkey,drop constraint attendance_variations_shift_id_key,alter column organization_id set not null,
 add primary key(organization_id,id),add unique(organization_id,shift_id),
 add foreign key(organization_id,shift_id) references public.shifts(organization_id,id) on delete cascade;
alter table public.notes drop constraint notes_pkey,alter column organization_id set not null,add primary key(organization_id,id),
 add foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete set null (employee_id);
alter table public.settings drop constraint settings_pkey,alter column organization_id set not null,add primary key(organization_id,id);
alter table public.planner_state drop constraint planner_state_pkey,alter column organization_id set not null,add primary key(organization_id,id);
create index shifts_organization_date_idx on public.shifts(organization_id,date);
create index notes_organization_date_idx on public.notes(organization_id,date);
create index notes_organization_employee_idx on public.notes(organization_id,employee_id);
create function public.current_organization_id() returns uuid language sql stable security definer set search_path='' as $$
 select organization_id from public.profiles where user_id=auth.uid() and role in ('admin','manager')
$$;
revoke all on function public.current_organization_id() from public,anon;
grant execute on function public.current_organization_id() to authenticated;
-- Remove old permissive policies; all business writes go through revision-checked RPCs.
do $$ declare p record; t text; begin
 for p in select schemaname,tablename,policyname from pg_policies where schemaname='public'
 and tablename in ('employees','shifts','attendance_variations','notes','settings','planner_state','planner_access') loop
 execute format('drop policy %I on %I.%I',p.policyname,p.schemaname,p.tablename);
 end loop;
 foreach t in array array['employees','shifts','attendance_variations','notes','settings','planner_state'] loop
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy organization_scope on public.%I for all to authenticated using (organization_id=(select public.current_organization_id())) with check (organization_id=(select public.current_organization_id()))',t);
 end loop;
end $$;
revoke all on public.organizations,public.profiles,public.planner_access from public,anon,authenticated;
grant select on public.organizations,public.profiles to authenticated;
create policy own_organization on public.organizations for select to authenticated using(id=(select public.current_organization_id()));
create policy own_profile on public.profiles for select to authenticated using(user_id=(select auth.uid()));
create function public.account_context() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',p.user_id,'organization_id',p.organization_id,'organization_name',o.name,'full_name',p.full_name,'role',p.role)
 from public.profiles p join public.organizations o on o.id=p.organization_id where p.user_id=auth.uid() and p.role in ('admin','manager')
$$;
create function public.organization_onboard(organization_name text,manager_name text) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); oid uuid;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 perform 1 from auth.users where id=uid and email_confirmed_at is not null for update;
 if not found then raise exception 'Confirmed email required' using errcode='42501'; end if;
 if exists(select 1 from public.profiles where user_id=uid) then return public.account_context(); end if;
 if organization_name is null or length(trim(organization_name)) not between 1 and 200 or manager_name is null or length(trim(manager_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 insert into public.organizations(name) values(trim(organization_name)) returning id into oid;
 insert into public.profiles(user_id,organization_id,full_name,role) values(uid,oid,trim(manager_name),'admin');
 insert into public.planner_state(organization_id,id) values(oid,true);
 return public.account_context();
end $$;
create function public.account_update(manager_name text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if public.current_organization_id() is null then raise exception 'Access denied' using errcode='42501'; end if;
 if manager_name is null or length(trim(manager_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 update public.profiles set full_name=trim(manager_name),updated_at=now() where user_id=auth.uid();
 return public.account_context();
end $$;
revoke all on function public.account_context(),public.organization_onboard(text,text),public.account_update(text) from public,anon;
grant execute on function public.account_context(),public.organization_onboard(text,text),public.account_update(text) to authenticated;
create or replace function public.planner_load() returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); result jsonb;
begin
 if auth.uid() is null or oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 select jsonb_build_object('organization_id',oid,'revision',st.revision,
 'empty',not exists(select 1 from public.settings where organization_id=oid) and not exists(select 1 from public.employees where organization_id=oid) and not exists(select 1 from public.notes where organization_id=oid),
 'snapshot',jsonb_build_object(
 'data',jsonb_build_object('version',1,
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by position,id) from public.employees where organization_id=oid),'[]'::jsonb),
 'shifts',coalesce((select jsonb_object_agg(id,case when type in ('Riposo','Malattia','Ferie') then jsonb_build_object('type',type,'off',true) else jsonb_build_object('type',type,'off',false,'start',to_char(start_time,'HH24:MI'),'end',to_char(end_time,'HH24:MI')) end) from public.shifts where organization_id=oid),'{}'::jsonb)),
 'notes',coalesce((select jsonb_agg(jsonb_build_object('id',id,'text',text,'date',coalesce(to_char(date,'YYYY-MM-DD'),''),'employeeId',coalesce(employee_id,'')) order by position,id) from public.notes where organization_id=oid),'[]'::jsonb),
 'variations',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('employeeId',s.employee_id,'date',to_char(s.date,'YYYY-MM-DD'),'start',to_char(v.actual_start_time,'HH24:MI'),'end',to_char(v.actual_end_time,'HH24:MI'),'reason',v.reason,'customReason',v.custom_reason,'note',v.note)) from public.attendance_variations v join public.shifts s on s.organization_id=v.organization_id and s.id=v.shift_id where v.organization_id=oid),'{}'::jsonb),
 'settings',(select value from public.settings where organization_id=oid and id=true))) into result from public.planner_state st where st.organization_id=oid and st.id=true;
 if result is null then raise exception 'Organization state missing'; end if;
 return result;
end $$;
create or replace function public.planner_save(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); current_revision bigint; k text; v jsonb;
begin
 if auth.uid() is null or oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 -- Browser context is only a precondition, never an authority: prevents stale
 -- requests writing into a new membership if an administrator moves a user.
 if payload->>'expected_organization_id' is distinct from oid::text then raise exception 'Organization changed' using errcode='42501'; end if;
 -- The browser never chooses the target organization. Reject explicit spoofing.
 if payload ? 'organization_id' or payload ? 'organizationId' then raise exception 'Organization is server-derived' using errcode='42501'; end if;
 select revision into current_revision from public.planner_state where organization_id=oid and id=true for update;
 if expected_revision is null or current_revision is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if only_empty is null then raise exception 'Invalid import mode'; end if;
 if only_empty and (exists(select 1 from public.employees where organization_id=oid) or exists(select 1 from public.settings where organization_id=oid) or exists(select 1 from public.notes where organization_id=oid)) then raise exception 'Organization not empty' using errcode='40001'; end if;
 if payload->'data'->>'version' is distinct from '1' or not public.planner_valid_settings(payload->'settings')
 or jsonb_typeof(payload->'data'->'employees') is distinct from 'array' or jsonb_typeof(payload->'notes') is distinct from 'array'
 or jsonb_typeof(payload->'data'->'shifts') is distinct from 'object' or jsonb_typeof(payload->'variations') is distinct from 'object' then raise exception 'Invalid payload'; end if;
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
 if v->>'type' in ('Mattina','Pomeriggio') and (v->>'start' is distinct from payload->'settings'->'presets'->(v->>'type')->>'start' or v->>'end' is distinct from payload->'settings'->'presets'->(v->>'type')->>'end') then raise exception 'Preset mismatch'; end if;
 if not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=left(k,length(k)-11)) then raise exception 'Orphan shift'; end if;
 if v->>'type' in ('Mattina','Pomeriggio','Centrale') and (v->>'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'start'=v->>'end') then raise exception 'Invalid shift time'; end if;
 end loop;
 for k,v in select key,value from jsonb_each(payload->'variations') loop
 if k is distinct from (v->>'employeeId')||'|'||(v->>'date') or not (payload->'data'->'shifts' ? k) then raise exception 'Orphan variation'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(payload->'notes') n where coalesce(n->>'employeeId','')<>'' and not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=n->>'employeeId')) then raise exception 'Orphan note'; end if;
 insert into public.employees(organization_id,id,name,position)
 select oid,e->>'id',e->>'name',ord from jsonb_array_elements(payload->'data'->'employees') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set name=excluded.name,position=excluded.position,updated_at=now();
 delete from public.attendance_variations where organization_id=oid and id not in(select key from jsonb_each(payload->'variations'));
 delete from public.shifts where organization_id=oid and id not in(select key from jsonb_each(payload->'data'->'shifts'));
 insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time)
 select oid,key,left(key,length(key)-11),right(key,10)::date,value->>'type',(value->>'start')::time,(value->>'end')::time from jsonb_each(payload->'data'->'shifts')
 on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,end_time=excluded.end_time,updated_at=now();
 insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note)
 select oid,key,key,(value->>'start')::time,(value->>'end')::time,value->>'reason',value->>'customReason',value->>'note' from jsonb_each(payload->'variations')
 on conflict(organization_id,id) do update set actual_start_time=excluded.actual_start_time,actual_end_time=excluded.actual_end_time,reason=excluded.reason,custom_reason=excluded.custom_reason,note=excluded.note,updated_at=now();
 if exists(select 1 from public.attendance_variations v join public.shifts s on s.organization_id=v.organization_id and s.id=v.shift_id where v.organization_id=oid and s.type in ('Riposo','Malattia','Ferie')) then raise exception 'Invalid variation'; end if;
 delete from public.notes where organization_id=oid and id not in(select e->>'id' from jsonb_array_elements(payload->'notes') e);
 insert into public.notes(organization_id,id,text,date,employee_id,position)
 select oid,e->>'id',e->>'text',nullif(e->>'date','')::date,nullif(e->>'employeeId',''),ord from jsonb_array_elements(payload->'notes') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set text=excluded.text,date=excluded.date,employee_id=excluded.employee_id,position=excluded.position,updated_at=now();
 delete from public.employees where organization_id=oid and id not in(select e->>'id' from jsonb_array_elements(payload->'data'->'employees') e);
 insert into public.settings(organization_id,id,value) values(oid,true,payload->'settings') on conflict(organization_id,id) do update set value=excluded.value,updated_at=now();
 update public.planner_state set revision=revision+1 where organization_id=oid and id=true;
 return public.planner_load();
end $$;
revoke all on function public.planner_load(),public.planner_save(jsonb,bigint,boolean) from public,anon;
grant execute on function public.planner_load(),public.planner_save(jsonb,bigint,boolean) to authenticated;
commit;
