-- Apply after 010_personal_planner_preferences.sql. Hidden planner rows are personal UI state.
begin;

alter table public.user_preferences
 add column hidden_employee_ids text[] not null default '{}'::text[]
  check(cardinality(hidden_employee_ids)<=10000);

create or replace function public.user_planner_preferences() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences;
begin
 m:=planner_private.lock_member(public.current_organization_id());
 select * into result from public.user_preferences where user_id=m.user_id and organization_id=m.organization_id;
 return jsonb_build_object(
  'organization_id',m.organization_id,
  'employee_column_width',coalesce(result.employee_column_width,190),
  'employee_order',coalesce(to_jsonb(result.employee_order),'[]'::jsonb),
  'hidden_employee_ids',coalesce(to_jsonb(result.hidden_employee_ids),'[]'::jsonb)
 );
end $$;

create function public.user_planner_visibility_save(p_organization_id uuid,p_hidden_employee_ids text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences;
begin
 m:=planner_private.lock_member(p_organization_id);
 if not planner_private.valid_employee_order(m.organization_id,p_hidden_employee_ids) then
  raise exception 'Invalid planner visibility';
 end if;
 insert into public.user_preferences(user_id,organization_id,hidden_employee_ids)
 values(m.user_id,m.organization_id,p_hidden_employee_ids)
 on conflict(user_id) do update set
  organization_id=excluded.organization_id,
  hidden_employee_ids=excluded.hidden_employee_ids,
  updated_at=now()
 returning * into result;
 return jsonb_build_object(
  'organization_id',result.organization_id,
  'hidden_employee_ids',to_jsonb(result.hidden_employee_ids)
 );
end $$;

revoke all on function public.user_planner_visibility_save(uuid,text[]) from public,anon;
grant execute on function public.user_planner_visibility_save(uuid,text[]) to authenticated;
notify pgrst, 'reload schema';
commit;
