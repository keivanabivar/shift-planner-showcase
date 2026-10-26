begin;
create table public.planner_state (id boolean primary key default true check(id), revision bigint not null default 0);
insert into public.planner_state(id) values(true);
create table public.employees (id text primary key, name text not null check(length(trim(name))>0), position integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.shifts (
 id text primary key, employee_id text not null references public.employees(id) on delete cascade,
 date date not null, type text not null check(type in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie')),
 start_time time, end_time time, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(employee_id,date), check ((type in ('Riposo','Malattia','Ferie') and start_time is null and end_time is null) or (type in ('Mattina','Pomeriggio','Centrale') and start_time is not null and end_time is not null))
);
create index shifts_date_idx on public.shifts(date);
create table public.attendance_variations (
 id text primary key, shift_id text not null unique references public.shifts(id) on delete cascade,
 actual_start_time time not null, actual_end_time time not null, reason text not null check(reason in ('Ritardo','Uscita anticipata','Permesso','Malessere','Altro')),
 custom_reason text not null default '', note text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(actual_start_time<>actual_end_time),check(reason<>'Altro' or length(trim(custom_reason))>0)
);
create table public.notes (id text primary key, text text not null check(length(trim(text))>0), date date, employee_id text references public.employees(id) on delete set null, position integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index notes_employee_idx on public.notes(employee_id);
create index notes_date_idx on public.notes(date);
create table public.settings (id boolean primary key default true check(id), value jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create function public.planner_load() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('revision',st.revision,'empty',not exists(select 1 from public.settings) and not exists(select 1 from public.employees) and not exists(select 1 from public.notes),'snapshot',jsonb_build_object(
 'data',jsonb_build_object('version',1,'employees',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by position,id) from public.employees),'[]'::jsonb),'shifts',coalesce((select jsonb_object_agg(id,case when type in ('Riposo','Malattia','Ferie') then jsonb_build_object('type',type,'off',true) else jsonb_build_object('type',type,'off',false,'start',to_char(start_time,'HH24:MI'),'end',to_char(end_time,'HH24:MI')) end) from public.shifts),'{}'::jsonb)),
 'notes',coalesce((select jsonb_agg(jsonb_build_object('id',id,'text',text,'date',coalesce(to_char(date,'YYYY-MM-DD'),''),'employeeId',coalesce(employee_id,'')) order by position,id) from public.notes),'[]'::jsonb),
 'variations',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('employeeId',s.employee_id,'date',to_char(s.date,'YYYY-MM-DD'),'start',to_char(v.actual_start_time,'HH24:MI'),'end',to_char(v.actual_end_time,'HH24:MI'),'reason',v.reason,'customReason',v.custom_reason,'note',v.note)) from public.attendance_variations v join public.shifts s on s.id=v.shift_id),'{}'::jsonb),
 'settings',(select value from public.settings where id=true))) from public.planner_state st where st.id=true;
$$;
create function public.planner_save(payload jsonb, expected_revision bigint, only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 select revision into current_revision from public.planner_state where id=true for update;
 if current_revision is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if only_empty and (exists(select 1 from public.employees) or exists(select 1 from public.settings) or exists(select 1 from public.notes)) then raise exception 'Database not empty' using errcode='40001'; end if;
 if jsonb_typeof(payload->'data'->'employees') is distinct from 'array' or jsonb_typeof(payload->'data'->'shifts') is distinct from 'object' or jsonb_typeof(payload->'notes') is distinct from 'array' or jsonb_typeof(payload->'variations') is distinct from 'object' or jsonb_typeof(payload->'settings') is distinct from 'object' then raise exception 'Invalid payload'; end if;
 insert into public.employees(id,name,position) select e->>'id',e->>'name',ord from jsonb_array_elements(payload->'data'->'employees') with ordinality t(e,ord) on conflict(id) do update set name=excluded.name,position=excluded.position,updated_at=now();
 delete from public.attendance_variations where id not in(select key from jsonb_each(payload->'variations'));
 delete from public.shifts where id not in(select key from jsonb_each(payload->'data'->'shifts'));
 insert into public.shifts(id,employee_id,date,type,start_time,end_time)
 select key,left(key,length(key)-11),right(key,10)::date,value->>'type',(value->>'start')::time,(value->>'end')::time from jsonb_each(payload->'data'->'shifts')
 on conflict(id) do update set type=excluded.type,start_time=excluded.start_time,end_time=excluded.end_time,updated_at=now();
 insert into public.attendance_variations(id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note)
 select key,key,(value->>'start')::time,(value->>'end')::time,value->>'reason',value->>'customReason',value->>'note' from jsonb_each(payload->'variations')
 on conflict(id) do update set actual_start_time=excluded.actual_start_time,actual_end_time=excluded.actual_end_time,reason=excluded.reason,custom_reason=excluded.custom_reason,note=excluded.note,updated_at=now();
 if exists(select 1 from public.attendance_variations v join public.shifts s on s.id=v.shift_id where s.type in ('Riposo','Malattia','Ferie')) then raise exception 'Invalid variation'; end if;
 delete from public.notes where id not in(select e->>'id' from jsonb_array_elements(payload->'notes') e);
 insert into public.notes(id,text,date,employee_id,position) select e->>'id',e->>'text',nullif(e->>'date','')::date,nullif(e->>'employeeId',''),ord from jsonb_array_elements(payload->'notes') with ordinality t(e,ord)
 on conflict(id) do update set text=excluded.text,date=excluded.date,employee_id=excluded.employee_id,position=excluded.position,updated_at=now();
 delete from public.employees where id not in(select e->>'id' from jsonb_array_elements(payload->'data'->'employees') e);
 insert into public.settings(id,value) values(true,payload->'settings') on conflict(id) do update set value=excluded.value,updated_at=now();
 update public.planner_state set revision=revision+1 where id=true;
 return public.planner_load();
end;
$$;
-- No public access is enabled by this migration. These are personal staff records.
alter table public.employees enable row level security;
alter table public.shifts enable row level security;
alter table public.attendance_variations enable row level security;
alter table public.notes enable row level security;
alter table public.settings enable row level security;
alter table public.planner_state enable row level security;
revoke all on public.employees,public.shifts,public.attendance_variations,public.notes,public.settings,public.planner_state from anon,authenticated;
revoke all on function public.planner_load() from public,anon,authenticated;
revoke all on function public.planner_save(jsonb,bigint,boolean) from public,anon,authenticated;
commit;
