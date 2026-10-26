-- Apply after 011_personal_planner_visibility.sql.
-- The preferences reader must remain read-only: PostgREST executes STABLE RPCs
-- in a read-only transaction, so it cannot call lock_member() (SELECT FOR UPDATE).
begin;

create or replace function public.user_planner_preferences() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.profiles; result public.user_preferences;
begin
 select * into m
 from public.profiles
 where user_id=auth.uid()
  and is_active
  and role in ('admin','editor','viewer');
 if not found then
  raise exception 'Access denied' using errcode='42501';
 end if;
 select * into result
 from public.user_preferences
 where user_id=m.user_id and organization_id=m.organization_id;
 return jsonb_build_object(
  'organization_id',m.organization_id,
  'employee_column_width',coalesce(result.employee_column_width,190),
  'employee_order',coalesce(to_jsonb(result.employee_order),'[]'::jsonb),
  'hidden_employee_ids',coalesce(to_jsonb(result.hidden_employee_ids),'[]'::jsonb)
 );
end $$;

revoke all on function public.user_planner_preferences() from public,anon;
grant execute on function public.user_planner_preferences() to authenticated;
notify pgrst, 'reload schema';
commit;
