-- Apply after 001_planner.sql. Transactional; does not reset existing data.
begin;
create table public.planner_access (
 id boolean primary key default true check(id),
 manager_id uuid unique references auth.users(id) on delete restrict,
 public_test_mode boolean not null default false
);
insert into public.planner_access(id) values(true);
alter table public.planner_access enable row level security;
revoke all on public.planner_access from public,anon,authenticated;
create function public.planner_access_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.planner_access where id=true and (public_test_mode or manager_id=auth.uid()));
$$;
revoke all on function public.planner_access_allowed() from public;
grant execute on function public.planner_access_allowed() to anon,authenticated;
-- RLS remains deny-by-default until the owner explicitly configures access.
create policy planner_manager on public.employees for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
create policy planner_manager on public.shifts for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
create policy planner_manager on public.attendance_variations for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
create policy planner_manager on public.notes for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
create policy planner_manager on public.settings for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
create policy planner_manager on public.planner_state for all to anon,authenticated using(public.planner_access_allowed()) with check(public.planner_access_allowed());
-- Direct table writes stay revoked: RPCs serialize all mutations and revisions.
alter function public.planner_load() rename to planner_load_internal;
alter function public.planner_save(jsonb,bigint,boolean) rename to planner_save_internal;
revoke all on function public.planner_load_internal() from public,anon,authenticated;
revoke all on function public.planner_save_internal(jsonb,bigint,boolean) from public,anon,authenticated;
create function public.planner_load() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.planner_access_allowed() then raise exception 'Access denied' using errcode='42501'; end if;
 return public.planner_load_internal();
end;
$$;
create function public.planner_valid_settings(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare t text; a text; b text;
begin
 if jsonb_typeof(v) is distinct from 'object' then return false; end if;
 foreach t in array array['Mattina','Pomeriggio'] loop
 a:=v->'presets'->t->>'start';b:=v->'presets'->t->>'end';
 if a is null or b is null or a !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or b !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or a=b then return false; end if;
 end loop;
 foreach t in array array['Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie'] loop
 if v->'colors'->>t is null or v->'colors'->>t !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
 end loop;return true;
end;
$$;
revoke all on function public.planner_valid_settings(jsonb) from public,anon,authenticated;
alter table public.settings add constraint settings_valid check(public.planner_valid_settings(value));
alter table public.employees add constraint employee_id_not_empty check(length(id)>0);
alter table public.notes add constraint note_id_not_empty check(length(id)>0);
alter table public.shifts add constraint shift_key_matches check(id=employee_id||'|'||date::text);
alter table public.attendance_variations add constraint variation_key_matches check(id=shift_id);
create function public.planner_save(payload jsonb, expected_revision bigint, only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; v jsonb;
begin
 if not public.planner_access_allowed() then raise exception 'Access denied' using errcode='42501'; end if;
 if expected_revision is null or only_empty is null then raise exception 'Invalid revision'; end if;
 if payload->'data'->>'version' is distinct from '1' or not public.planner_valid_settings(payload->'settings') then raise exception 'Invalid payload'; end if;
 if jsonb_typeof(payload->'data'->'employees') is distinct from 'array' or jsonb_typeof(payload->'notes') is distinct from 'array' or jsonb_typeof(payload->'data'->'shifts') is distinct from 'object' or jsonb_typeof(payload->'variations') is distinct from 'object' then raise exception 'Invalid payload'; end if;
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
 if v->>'type' in ('Mattina','Pomeriggio') and (v->>'start' is distinct from payload->'settings'->'presets'->(v->>'type')->>'start' or v->>'end' is distinct from payload->'settings'->'presets'->(v->>'type')->>'end') then raise exception 'Preset mismatch'; end if;
 if not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=left(k,length(k)-11)) then raise exception 'Orphan shift'; end if;
 end loop;
 for k,v in select key,value from jsonb_each(payload->'variations') loop
 if k is distinct from (v->>'employeeId')||'|'||(v->>'date') or not (payload->'data'->'shifts' ? k) then raise exception 'Orphan variation'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(payload->'notes') n where coalesce(n->>'employeeId','')<>'' and not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=n->>'employeeId')) then raise exception 'Orphan note'; end if;
 return public.planner_save_internal(payload,expected_revision,only_empty);
end;
$$;
revoke all on function public.planner_load() from public;
revoke all on function public.planner_save(jsonb,bigint,boolean) from public;
grant execute on function public.planner_load() to anon,authenticated;
grant execute on function public.planner_save(jsonb,bigint,boolean) to anon,authenticated;
commit;
