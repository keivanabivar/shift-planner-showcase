-- Apply after 003_organizations_auth.sql. Transactional and non-destructive.
begin;
alter table public.shifts drop constraint shifts_type_check;
alter table public.shifts drop constraint shifts_check;
alter table public.shifts add column preset_id text,add column preset_name text,add column preset_color text;
alter table public.shifts add constraint shifts_type_or_custom check(
 (type in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie') and preset_id is null and preset_name is null and preset_color is null)
 or (type not in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie') and (
  (preset_id is null and preset_name is null and preset_color is null)
  or (length(preset_id)>0 and preset_name=type and length(trim(preset_name)) between 1 and 100 and preset_color ~ '^#[0-9a-fA-F]{6}$')
 ))
);
alter table public.shifts add constraint shift_times_valid check(
 (type in ('Riposo','Malattia','Ferie') and start_time is null and end_time is null)
 or (type not in ('Riposo','Malattia','Ferie') and start_time is not null and end_time is not null)
);
create index shifts_organization_preset_idx on public.shifts(organization_id,preset_id) where preset_id is not null;

-- One atomic form save. The tenant always comes from auth.uid(); only admins may rename it.
create function public.account_update(manager_name text,organization_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare oid uuid; member_role text; current_name text;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select p.organization_id,p.role,o.name into oid,member_role,current_name from public.profiles p join public.organizations o on o.id=p.organization_id where p.user_id=auth.uid() for update of p,o;
 if oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 if manager_name is null or length(trim(manager_name)) not between 1 and 200 or organization_name is null or length(trim(organization_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 if trim(organization_name) is distinct from current_name and member_role<>'admin' then raise exception 'Only administrators may rename the organization' using errcode='42501'; end if;
 update public.profiles set full_name=trim(manager_name),updated_at=now() where user_id=auth.uid();
 if trim(organization_name) is distinct from current_name then update public.organizations set name=trim(organization_name),updated_at=now() where id=oid; end if;
 return public.account_context();
end $$;
revoke all on function public.account_update(text,text) from public,anon;
grant execute on function public.account_update(text,text) to authenticated;

-- Keep the verified v3 tenant implementation and wrap only serialization/validation.
alter function public.planner_load() rename to planner_load_v3;
alter function public.planner_save(jsonb,bigint,boolean) rename to planner_save_v3;
revoke all on function public.planner_load_v3(),public.planner_save_v3(jsonb,bigint,boolean) from public,anon,authenticated;
create function public.planner_load() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; item record; path text[];
begin
 result:=public.planner_load_v3();
 for item in select id,preset_id,preset_name,preset_color from public.shifts where organization_id=public.current_organization_id() and preset_id is not null loop
  path:=array['snapshot','data','shifts',item.id];
  result:=jsonb_set(result,path,(result#>path)||jsonb_build_object('presetId',item.preset_id,'presetName',item.preset_name,'presetColor',item.preset_color),false);
 end loop;
 return result;
end $$;
create function public.planner_save(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); k text; v jsonb; preset jsonb; result jsonb;
begin
 if auth.uid() is null or oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 if jsonb_typeof(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb))<>'array' then raise exception 'Invalid custom presets'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p
  where nullif(trim(p->>'id'),'') is null or length(trim(p->>'name')) not between 1 and 100
  or p->>'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or p->>'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or p->>'start'=p->>'end' or p->>'color' !~ '^#[0-9a-fA-F]{6}$') then raise exception 'Invalid custom preset'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p group by lower(trim(p->>'name')) having count(*)>1)
 or exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p group by p->>'id' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p where lower(trim(p->>'name')) in ('mattina','pomeriggio','centrale','riposo','malattia','ferie')) then raise exception 'Duplicate custom preset'; end if;
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  if v ? 'presetId' then
   if nullif(v->>'presetId','') is null or nullif(trim(v->>'presetName'),'') is null or v->>'type' is distinct from v->>'presetName' or v->>'presetColor' !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid custom shift'; end if;
   select p into preset from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p where p->>'id'=v->>'presetId';
   if preset is not null and (v->>'presetName' is distinct from preset->>'name' or v->>'start' is distinct from preset->>'start' or v->>'end' is distinct from preset->>'end' or upper(v->>'presetColor') is distinct from upper(preset->>'color')) then raise exception 'Custom preset mismatch'; end if;
  elsif v->>'type' not in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie') then raise exception 'Unknown shift type';
  end if;
 end loop;
 result:=public.planner_save_v3(payload,expected_revision,only_empty);
 update public.shifts s set preset_id=v.value->>'presetId',preset_name=v.value->>'presetName',preset_color=upper(v.value->>'presetColor')
 from jsonb_each(payload->'data'->'shifts') v where s.organization_id=oid and s.id=v.key and v.value ? 'presetId';
 update public.shifts s set preset_id=null,preset_name=null,preset_color=null
 where s.organization_id=oid and preset_id is not null and not exists(select 1 from jsonb_each(payload->'data'->'shifts') v where v.key=s.id and v.value ? 'presetId');
 return public.planner_load();
end $$;
revoke all on function public.planner_load(),public.planner_save(jsonb,bigint,boolean) from public,anon;
grant execute on function public.planner_load(),public.planner_save(jsonb,bigint,boolean) to authenticated;
commit;
