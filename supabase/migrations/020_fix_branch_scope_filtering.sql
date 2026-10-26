-- Keep the 018 implementation intact and narrow its result to the branch scope
-- selected by the UI. Viewer `all_branches` means all explicitly authorized
-- branches (accepted invitations), not every active branch in the organization.
alter function public.planner_load_scoped(uuid,uuid[]) rename to planner_load_scoped_unfiltered;

create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 m public.profiles; authorized uuid[]; requested uuid[]; raw jsonb; raw_shifts jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 requested:=p_branch_ids;

 if m.role='viewer' and m.visibility_level='all_branches' then
  select array_agg(distinct b.id order by b.id) into authorized
  from public.branches b
  join public.organization_invitations i on i.organization_id=b.organization_id and i.target_branch_id=b.id
  where b.organization_id=p_organization_id and b.active and i.accepted_by=m.user_id and i.accepted_at is not null;

  -- Legacy viewers predate branch invitations and retain their former scope.
  if coalesce(cardinality(authorized),0)=0 then
   select array_agg(b.id order by b.created_at,b.id) into authorized
   from public.branches b where b.organization_id=p_organization_id and b.active;
  end if;
  authorized:=coalesce(authorized,'{}'::uuid[]);
  if requested is null or cardinality(requested)=0 then requested:=authorized;
  elsif exists(select 1 from unnest(requested) q(id) where not (q.id=any(authorized))) then
   raise exception 'Branch scope denied' using errcode='42501';
  end if;
 end if;

 raw:=public.planner_load_scoped_unfiltered(p_organization_id,requested);
 requested:=coalesce(array(select jsonb_array_elements_text(raw->'selected_branch_ids')::uuid),'{}'::uuid[]);
 raw_shifts:=coalesce(raw#>'{snapshot,data,shifts}','{}'::jsonb);

 raw:=jsonb_set(raw,'{snapshot,data,shifts}',coalesce((
  select jsonb_object_agg(item.key,item.value) from jsonb_each(raw_shifts) item
  where (item.value->>'branchId')::uuid=any(requested)
 ),'{}'::jsonb));
 raw:=jsonb_set(raw,'{snapshot,data,employees}',coalesce((
  select jsonb_agg(employee.value order by employee.ordinality)
  from jsonb_array_elements(raw#>'{snapshot,data,employees}') with ordinality employee(value,ordinality)
  where employee.value->>'homeBranchId'=any(select id::text from unnest(requested) q(id))
   or exists(select 1 from jsonb_each(raw_shifts) shift
    where shift.key like (employee.value->>'id')||'|%'
     and (shift.value->>'branchId')::uuid=any(requested))
 ),'[]'::jsonb));
 raw:=jsonb_set(raw,'{snapshot,variations}',coalesce((
  select jsonb_object_agg(item.key,item.value) from jsonb_each(coalesce(raw#>'{snapshot,variations}','{}'::jsonb)) item
  where (item.value->>'branchId')::uuid=any(requested)
 ),'{}'::jsonb));
 raw:=jsonb_set(raw,'{branches}',coalesce((
  select jsonb_agg(jsonb_set(branch.value,'{readable}',to_jsonb((branch.value->>'id')::uuid=any(requested))) order by branch.ordinality)
  from jsonb_array_elements(raw->'branches') with ordinality branch(value,ordinality)
 ),'[]'::jsonb));
 return raw;
end $$;

revoke all on function public.planner_load_scoped_unfiltered(uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.planner_load_scoped(uuid,uuid[]) from public,anon;
grant execute on function public.planner_load_scoped(uuid,uuid[]) to authenticated;
