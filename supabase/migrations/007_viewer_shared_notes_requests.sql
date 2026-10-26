-- Viewer team notes and least-privilege request visibility.
-- Apply once after 006_invite_account_auth.sql.
begin;

do $$ begin
 if to_regclass('public.requests') is null or to_regprocedure('public.planner_load()') is null then
  raise exception '007 requires migrations 001 through 006';
 end if;
end $$;

drop policy if exists writer_tenant_read on public.notes;
drop policy if exists active_tenant_read on public.notes;
create policy active_tenant_read on public.notes for select to authenticated
 using (organization_id=(select public.current_organization_id()));

drop policy if exists active_tenant_read on public.requests;
create policy member_request_read on public.requests for select to authenticated using (
 organization_id=(select public.current_organization_id())
 and exists (
  select 1 from public.profiles p
  where p.user_id=(select auth.uid()) and p.organization_id=requests.organization_id and p.is_active
  and (
   p.role in ('admin','editor')
   or (p.role='viewer' and (requests.status='pending' or requests.employee_id=p.employee_id))
  )
 )
);

create function public.request_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(p_organization_id);
 return coalesce((
  select jsonb_agg(to_jsonb(r) order by r.created_at desc)
  from public.requests r
  where r.organization_id=p_organization_id
  and (m.role in ('admin','editor') or r.status='pending' or r.employee_id=m.employee_id)
 ),'[]'::jsonb);
end $$;

create or replace function public.planner_load() returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 oid uuid:=public.current_organization_id();
 member_role text;
 result jsonb;
begin
 if oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform 1 from public.planner_state where organization_id=oid and id=true for share;
 if not found then raise exception 'Organization state missing'; end if;
 select role into member_role from public.profiles
 where user_id=auth.uid() and organization_id=oid and is_active;
 if member_role is null then raise exception 'Access denied' using errcode='42501'; end if;
 result:=public.planner_load_v4();
 -- Notes are shared team information. Attendance details remain managerial.
 if member_role='viewer' then
  result:=jsonb_set(result,'{snapshot,variations}','{}'::jsonb,false);
 end if;
 return result;
end $$;

revoke all on function public.request_list(uuid) from public,anon,authenticated;
grant execute on function public.request_list(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
