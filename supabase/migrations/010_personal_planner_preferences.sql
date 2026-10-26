-- Apply after 009_request_receipts_dynamic_unread.sql. Personal planner UI preferences only.
begin;

alter table public.user_preferences
 add column employee_column_width integer not null default 190
  check(employee_column_width between 140 and 320),
 add column employee_order text[] not null default '{}'::text[]
  check(cardinality(employee_order)<=10000);

create function planner_private.valid_employee_order(p_organization_id uuid,p_order text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select p_order is not null
  and cardinality(p_order)<=10000
  and cardinality(p_order)=cardinality(array(select distinct value from unnest(p_order) value))
  and not exists(
   select 1 from unnest(p_order) value
   where value is null or length(value) not between 1 and 200
    or not exists(select 1 from public.employees e where e.organization_id=p_organization_id and e.id=value)
  )
$$;

create function public.user_planner_preferences() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences;
begin
 m:=planner_private.lock_member(public.current_organization_id());
 select * into result from public.user_preferences where user_id=m.user_id and organization_id=m.organization_id;
 return jsonb_build_object(
  'organization_id',m.organization_id,
  'employee_column_width',coalesce(result.employee_column_width,190),
  'employee_order',coalesce(to_jsonb(result.employee_order),'[]'::jsonb)
 );
end $$;

create function public.user_planner_preferences_save(p_organization_id uuid,p_employee_column_width integer,p_employee_order text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences;
begin
 m:=planner_private.lock_member(p_organization_id);
 if p_employee_column_width is null or p_employee_column_width not between 140 and 320
  or not planner_private.valid_employee_order(m.organization_id,p_employee_order) then raise exception 'Invalid planner preferences'; end if;
 insert into public.user_preferences(user_id,organization_id,employee_column_width,employee_order)
 values(m.user_id,m.organization_id,p_employee_column_width,p_employee_order)
 on conflict(user_id) do update set
  organization_id=excluded.organization_id,
  employee_column_width=excluded.employee_column_width,
  employee_order=excluded.employee_order,
  updated_at=now()
 returning * into result;
 return jsonb_build_object(
  'organization_id',result.organization_id,
  'employee_column_width',result.employee_column_width,
  'employee_order',to_jsonb(result.employee_order)
 );
end $$;

revoke all on function planner_private.valid_employee_order(uuid,text[]) from public,anon,authenticated;
revoke all on function public.user_planner_preferences(),public.user_planner_preferences_save(uuid,integer,text[]) from public,anon;
grant execute on function public.user_planner_preferences(),public.user_planner_preferences_save(uuid,integer,text[]) to authenticated;
notify pgrst, 'reload schema';
commit;
