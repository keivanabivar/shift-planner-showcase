-- Apply after 028. Local rehearsal only; no hosted database execution.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
create index shifts_template_color_scope on public.shifts(organization_id,branch_id,preset_id) where preset_id is not null;

-- Resolve the color even for restored request snapshots and stale copied shifts.
-- Deleted templates retain their last color; no name/time is resolved from them.
create function planner_private.shift_template_color() returns trigger
language plpgsql security definer set search_path='' as $$
declare template_color text;
begin
 select t.color into template_color from public.shift_templates t
 where t.organization_id=new.organization_id and t.branch_id=new.branch_id
 and (t.id::text=new.preset_id or t.legacy_preset_id=new.preset_id)
 order by (t.id::text=new.preset_id) desc limit 1;
 if found then new.preset_color:=template_color; end if;
 return new;
end $$;
create trigger shifts_resolve_template_color before insert or update on public.shifts
 for each row execute function planner_private.shift_template_color();

create function planner_private.propagate_template_color() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Match the same identity as shift_template_color(): an exact UUID (even a
 -- deleted template) shadows any legacy alias in this organization/Sede.
 update public.shifts s set preset_color=new.color
 where s.organization_id=new.organization_id and s.branch_id=new.branch_id
 and (s.preset_id=new.id::text or (s.preset_id=new.legacy_preset_id
  and not exists(select 1 from public.shift_templates t
   where t.organization_id=s.organization_id and t.branch_id=s.branch_id and t.id::text=s.preset_id)))
 and preset_color is distinct from new.color;
 return new;
end $$;
create trigger templates_propagate_color after update of color on public.shift_templates
 for each row when(old.color is distinct from new.color and new.deleted_at is null)
 execute function planner_private.propagate_template_color();
revoke all on function planner_private.shift_template_color(),planner_private.propagate_template_color() from public,anon,authenticated;

create or replace function planner_private.guard_archived_date() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_date date; new_date date; oid uuid;
begin
 -- Only the authoritative template color may bypass the archive lock.
 -- No timestamp, name, hours, request linkage or other field may change here.
 if tg_table_name='shifts' and tg_op='UPDATE' then
  if (to_jsonb(new)-'preset_color')=(to_jsonb(old)-'preset_color')
   and new.preset_color is distinct from old.preset_color
   and new.preset_color=(select t.color from public.shift_templates t where t.organization_id=new.organization_id
    and t.branch_id=new.branch_id and (t.id::text=new.preset_id or t.legacy_preset_id=new.preset_id)
    order by (t.id::text=new.preset_id) desc limit 1) then return new; end if;
 end if;
 oid:=case when tg_op='DELETE' then old.organization_id else new.organization_id end;
 if tg_table_name='attendance_variations' then
  if tg_op<>'INSERT' then select date into old_date from public.shifts where organization_id=old.organization_id and id=old.shift_id; end if;
  if tg_op<>'DELETE' then select date into new_date from public.shifts where organization_id=new.organization_id and id=new.shift_id; end if;
 elsif tg_table_name='requests' then
  if tg_op<>'INSERT' and not planner_private.retention_delete_allowed(old.organization_id,old.start_date)
   and (not planner_private.archive_month_allowed(old.start_date) or not planner_private.archive_month_allowed(old.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  if tg_op<>'DELETE' and not planner_private.retention_delete_allowed(new.organization_id,new.start_date)
   and (not planner_private.archive_month_allowed(new.start_date) or not planner_private.archive_month_allowed(new.end_date)) then raise exception 'Archived month is read only' using errcode='42501'; end if;
  return case when tg_op='DELETE' then old else new end;
 else
  if tg_op<>'INSERT' then old_date:=old.date; end if;
  if tg_op<>'DELETE' then new_date:=new.date; end if;
 end if;
 if (old_date is not null and planner_private.retention_delete_allowed(oid,old_date))
 or (new_date is not null and planner_private.retention_delete_allowed(oid,new_date)) then
  return case when tg_op='DELETE' then old else new end;
 end if;
 if not planner_private.archive_month_allowed(old_date) or not planner_private.archive_month_allowed(new_date) then
  if tg_op='INSERT' and tg_table_name='shifts' and exists(select 1 from public.shifts where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='attendance_variations' and exists(select 1 from public.attendance_variations where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='INSERT' and tg_table_name='notes' and exists(select 1 from public.notes where organization_id=new.organization_id and id=new.id) then return new; end if;
  if tg_op='UPDATE' and tg_table_name in ('shifts','attendance_variations','notes') then return old; end if;
  raise exception 'Archived month is read only' using errcode='42501';
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;

-- Expose the known 028 legacy linkage so color-only save verification is exact.
alter function public.planner_load_scoped(uuid,uuid[]) rename to planner_load_scoped_028;
revoke all on function public.planner_load_scoped_028(uuid,uuid[]) from public,anon,authenticated;
create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; templates jsonb; deleted_colors jsonb;
begin
 result:=public.planner_load_scoped_028(p_organization_id,p_branch_ids);
 select coalesce(jsonb_agg(item||case when t.legacy_preset_id is not null then jsonb_build_object('legacyPresetId',t.legacy_preset_id) else '{}'::jsonb end order by ord),'[]')
 into templates from jsonb_array_elements(result#>'{snapshot,settings,presets,custom}') with ordinality v(item,ord)
 join public.shift_templates t on t.organization_id=p_organization_id and t.id::text=item->>'id';
 -- Keep deleted templates out of current presets. Verification needs only
 -- their authoritative last color/linkage, scoped exactly like current presets.
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'branchId',t.branch_id,'color',t.color)||
  case when t.legacy_preset_id is not null then jsonb_build_object('legacyPresetId',t.legacy_preset_id) else '{}'::jsonb end order by t.id),'[]')
 into deleted_colors from public.shift_templates t
 where t.organization_id=p_organization_id and t.deleted_at is not null
 and t.branch_id in (select x::uuid from jsonb_array_elements_text(result->'selected_branch_ids') x)
 and planner_private.can_read_template_branch(p_organization_id,t.branch_id);
 return jsonb_set(result,'{snapshot,settings,presets,custom}',templates)||jsonb_build_object('deleted_template_colors',deleted_colors);
end $$;
revoke all on function public.planner_load_scoped(uuid,uuid[]) from public,anon;
grant execute on function public.planner_load_scoped(uuid,uuid[]) to authenticated;

-- Personal order and template sort are independently stored for each Sede.
-- The old global order is retained as an initial fallback; no historical order is lost.
create table public.user_branch_planner_preferences(
 user_id uuid not null references auth.users(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid not null,
 employee_order text[] check(cardinality(employee_order)<=10000),
 template_sort_key text not null default 'name' check(template_sort_key in ('name','start','end','duration')),
 template_sort_direction text not null default 'asc' check(template_sort_direction in ('asc','desc')),
 updated_at timestamptz not null default now(),
 primary key(user_id,organization_id,branch_id),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete cascade
);
alter table public.user_branch_planner_preferences enable row level security;
revoke all on public.user_branch_planner_preferences from public,anon,authenticated;

create or replace function public.user_planner_preferences() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences; scoped jsonb;
begin
 select * into m from public.profiles where user_id=auth.uid() and is_active and role in ('admin','editor','viewer');
 if not found then raise exception 'Access denied' using errcode='42501'; end if;
 select * into result from public.user_preferences where user_id=m.user_id and organization_id=m.organization_id;
 select coalesce(jsonb_object_agg(p.branch_id::text,jsonb_build_object(
  'employee_order',to_jsonb(p.employee_order),'template_sort',jsonb_build_object('key',p.template_sort_key,'direction',p.template_sort_direction))),'{}')
 into scoped from public.user_branch_planner_preferences p where p.user_id=m.user_id and p.organization_id=m.organization_id
 and planner_private.can_read_template_branch(m.organization_id,p.branch_id);
 return jsonb_build_object('organization_id',m.organization_id,'employee_column_width',coalesce(result.employee_column_width,190),
  'employee_order',coalesce(to_jsonb(result.employee_order),'[]'),'hidden_employee_ids',coalesce(to_jsonb(result.hidden_employee_ids),'[]'),
  'branch_preferences',scoped);
end $$;

create function public.user_branch_planner_preferences_save(p_organization_id uuid,p_branch_id uuid,
 p_employee_order text[] default null,p_template_sort_key text default null,p_template_sort_direction text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(p_organization_id);
 if p_branch_id is null or not planner_private.can_read_template_branch(m.organization_id,p_branch_id) then
  raise exception 'Branch scope denied' using errcode='42501'; end if;
 if p_employee_order is not null and ((cardinality(p_employee_order)>0 and array_ndims(p_employee_order) is distinct from 1) or not planner_private.valid_employee_order(m.organization_id,p_employee_order)
  or exists(select 1 from unnest(p_employee_order) id where not exists(select 1 from public.employee_branch_assignments a
   where a.organization_id=m.organization_id and a.branch_id=p_branch_id and a.employee_id=id))) then raise exception 'Invalid Sede employee order'; end if;
 if (p_template_sort_key is null)<>(p_template_sort_direction is null)
  or (p_template_sort_key is not null and (p_template_sort_key not in ('name','start','end','duration')
   or p_template_sort_direction not in ('asc','desc'))) then raise exception 'Invalid template sort'; end if;
 insert into public.user_branch_planner_preferences(user_id,organization_id,branch_id,employee_order,template_sort_key,template_sort_direction)
 values(m.user_id,m.organization_id,p_branch_id,p_employee_order,coalesce(p_template_sort_key,'name'),coalesce(p_template_sort_direction,'asc'))
 on conflict(user_id,organization_id,branch_id) do update set
 employee_order=coalesce(excluded.employee_order,user_branch_planner_preferences.employee_order),
 template_sort_key=coalesce(p_template_sort_key,user_branch_planner_preferences.template_sort_key),
 template_sort_direction=coalesce(p_template_sort_direction,user_branch_planner_preferences.template_sort_direction),updated_at=now();
 return public.user_planner_preferences();
end $$;
revoke all on function public.user_branch_planner_preferences_save(uuid,uuid,text[],text,text) from public,anon;
grant execute on function public.user_branch_planner_preferences_save(uuid,uuid,text[],text,text) to authenticated;
notify pgrst,'reload schema';
commit;
