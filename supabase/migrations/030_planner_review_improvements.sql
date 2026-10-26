-- Apply once after 029. Local rehearsal; no hosted execution.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
-- Drain existing application transactions before changing the write contract.
-- A lock timeout aborts the entire migration; it never leaves a half-open gate.
do $$ declare relation regclass; begin
 for relation in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' order by c.relname loop
  execute format('lock table %s in access exclusive mode',relation);
 end loop;
end $$;

-- Database-owned rollout switch. Applying 030 closes writes, including old web
-- tabs, older browser clients and a frontend rollback. No public setter exists.
create table planner_private.client_write_gate(
 singleton boolean primary key default true check(singleton),
 schema_version integer not null check(schema_version=30),
 client_protocol text not null check(client_protocol='planner-030-v1'),
 writes_enabled boolean not null default false
);
insert into planner_private.client_write_gate values(true,30,'planner-030-v1',false);
alter table planner_private.client_write_gate enable row level security;
revoke all on planner_private.client_write_gate from public,anon,authenticated;
create function public.planner_client_compatibility() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema_version',schema_version,'client_protocol',client_protocol,'writes_enabled',writes_enabled)
 from planner_private.client_write_gate where singleton
$$;
revoke all on function public.planner_client_compatibility() from public,anon;
grant execute on function public.planner_client_compatibility() to authenticated;
create function planner_private.assert_client_write() returns void
language plpgsql security definer set search_path='' as $$
declare gate planner_private.client_write_gate; headers jsonb;
begin
 -- The share lock is held until the entire write transaction finishes. Closing
 -- the switch waits for in-flight writes; later writes cannot slip past closure.
 select * into gate from planner_private.client_write_gate where singleton for share;
 begin headers:=nullif(current_setting('request.headers',true),'')::jsonb;
 exception when others then headers:=null;end;
 if auth.uid() is null or gate.singleton is null or not gate.writes_enabled
  or gate.schema_version<>30 or headers->>'x-planner-protocol' is distinct from gate.client_protocol then
  raise exception 'Modifiche bloccate. Ricarica la pagina; attendi il completamento dell’aggiornamento. I dati restano consultabili.' using errcode='P0030';
 end if;
end $$;
-- Operator-only switch. This is intentionally outside the exposed public schema.
create function planner_private.set_client_writes(p_enabled boolean,p_protocol text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_enabled is null or p_protocol is distinct from 'planner-030-v1' then raise exception 'Invalid rollout protocol';end if;
 update planner_private.client_write_gate set writes_enabled=p_enabled where singleton;
 if not found then raise exception 'Missing write gate';end if;
end $$;
revoke all on function planner_private.assert_client_write(),planner_private.set_client_writes(boolean,text) from public,anon,authenticated;

-- Defense in depth for invocations already running when the migration started
-- and for any overlooked legacy path. PostgREST's SET ROLE survives SECURITY
-- DEFINER calls; the function owner's current_user must not be used here.
create function planner_private.guard_client_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role',true) in ('anon','authenticated') then
  -- Only trusted PostgREST READ routes may initialize/materialize these rows.
  -- request.path is server context, not a client-supplied header. Missing or
  -- unknown paths fail closed; legacy archive writers get no table exemption.
  if tg_table_name in ('planner_state','branch_planner_state','archive_months')
   and current_setting('request.path',true) ~ '^/?rpc/(planner_load|planner_load_scoped|planner_load_scoped_020|archive_list)$' then return null;end if;
  perform planner_private.assert_client_write();
 end if;
 return null;
end $$;
revoke all on function planner_private.guard_client_write() from public,anon,authenticated;

-- Presentation is scoped to the same Sede as templates. Semantic status stays fixed.
create table public.branch_status_styles(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid not null, status text not null check(status in ('Riposo','Ferie','Malattia')),
 name text not null check(name=trim(name) and length(name) between 1 and 100),
 color text not null check(color ~ '^#[0-9a-fA-F]{6}$'),
 primary key(organization_id,branch_id,status),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete cascade
);
alter table public.branch_status_styles enable row level security;
revoke all on public.branch_status_styles from public,anon,authenticated;

create or replace function planner_private.shift_template_color() returns trigger
language plpgsql security definer set search_path='' as $$
declare t public.shift_templates;
begin
 select * into t from public.shift_templates
 where organization_id=new.organization_id and branch_id=new.branch_id
 and (id::text=new.preset_id or legacy_preset_id=new.preset_id)
 order by (id::text=new.preset_id) desc limit 1;
 if found then
  new.preset_color:=t.color;
  if t.deleted_at is null then new.type:=t.name;new.preset_name:=t.name;end if;
 end if;
 return new;
end $$;
create function planner_private.propagate_template_name() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update public.shifts s set type=new.name,preset_name=new.name
 where s.organization_id=new.organization_id and s.branch_id=new.branch_id
 and (s.preset_id=new.id::text or (s.preset_id=new.legacy_preset_id and not exists(
  select 1 from public.shift_templates t where t.organization_id=s.organization_id and t.branch_id=s.branch_id and t.id::text=s.preset_id)))
 and (s.type is distinct from new.name or s.preset_name is distinct from new.name);
 return new;
end $$;
create trigger templates_propagate_name after update of name on public.shift_templates
 for each row when(old.name is distinct from new.name and new.deleted_at is null)
 execute function planner_private.propagate_template_name();
revoke all on function planner_private.propagate_template_name() from public,anon,authenticated;
create or replace function planner_private.guard_archived_date() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_date date; new_date date; oid uuid;
begin
 -- Only authoritative presentation changes may bypass the archive lock.
 -- No hours, timestamp, request linkage or semantic status may change here.
 if tg_table_name='shifts' and tg_op='UPDATE' then
  if (to_jsonb(new)-array['preset_color','preset_name','type'])=(to_jsonb(old)-array['preset_color','preset_name','type'])
   and new.preset_id is not null
   and new.preset_color=(select t.color from public.shift_templates t where t.organization_id=new.organization_id
    and t.branch_id=new.branch_id and (t.id::text=new.preset_id or t.legacy_preset_id=new.preset_id)
    order by (t.id::text=new.preset_id) desc limit 1)
   and (new.type=old.type and new.preset_name is not distinct from old.preset_name or
    new.type=new.preset_name and new.type=(select t.name from public.shift_templates t where t.organization_id=new.organization_id
     and t.branch_id=new.branch_id and t.deleted_at is null and (t.id::text=new.preset_id or t.legacy_preset_id=new.preset_id)
     order by (t.id::text=new.preset_id) desc limit 1)) then return new; end if;
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

-- Optional time propagation is part of the same revision-checked transaction.
-- Compute the day on the server in the browser IANA timezone, not from a client date.
alter function planner_private.template_write(uuid,jsonb) rename to template_write_028;
create function planner_private.template_write(p_oid uuid,p_op jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare prior public.shift_templates; current_template public.shift_templates;
begin
 select * into prior from public.shift_templates where organization_id=p_oid and id=(p_op->>'id')::uuid;
 if p_op ? 'updateFutureTimes' and jsonb_typeof(p_op->'updateFutureTimes')<>'boolean' then raise exception 'Invalid time choice';end if;
 perform planner_private.template_write_028(p_oid,p_op);
 if p_op->>'kind'='template_upsert' and coalesce((p_op->>'updateFutureTimes')::boolean,false)
  and prior.id is not null and (prior.start_time<>(p_op->>'start')::time or prior.end_time<>(p_op->>'end')::time) then
  select * into current_template from public.shift_templates where organization_id=p_oid and id=prior.id;
  update public.shifts s set start_time=current_template.start_time,end_time=current_template.end_time,updated_at=now()
  where s.organization_id=p_oid and s.branch_id=current_template.branch_id and s.date>timezone(coalesce(p_op->>'timeZone','UTC'),now())::date
  and (s.preset_id=current_template.id::text or (s.preset_id=current_template.legacy_preset_id and not exists(
   select 1 from public.shift_templates t where t.organization_id=s.organization_id and t.branch_id=s.branch_id and t.id::text=s.preset_id)));
 end if;
end $$;
revoke all on function planner_private.template_write(uuid,jsonb),planner_private.template_write_028(uuid,jsonb) from public,anon,authenticated;

alter function public.planner_load_scoped(uuid,uuid[]) rename to planner_load_scoped_029;
revoke all on function public.planner_load_scoped_029(uuid,uuid[]) from public,anon,authenticated;
create function public.planner_load_scoped(p_organization_id uuid,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; styles jsonb;
begin
 result:=public.planner_load_scoped_029(p_organization_id,p_branch_ids);
 select coalesce(jsonb_object_agg(branch_id::text,value),'{}') into styles from (
  select branch_id,jsonb_object_agg(status,jsonb_build_object('name',name,'color',color)) value
  from public.branch_status_styles where organization_id=p_organization_id
  and branch_id in(select x::uuid from jsonb_array_elements_text(result->'selected_branch_ids') x)
  and planner_private.can_read_template_branch(p_organization_id,branch_id) group by branch_id
 ) q;
 return jsonb_set(result,'{snapshot,settings,statusStyles}',styles)||jsonb_build_object('planner_features',jsonb_build_object('template_names',true,'undo',true),'client_compatibility',public.planner_client_compatibility());
end $$;
revoke all on function public.planner_load_scoped(uuid,uuid[]) from public,anon;
grant execute on function public.planner_load_scoped(uuid,uuid[]) to authenticated;

-- Server-owned receipts preserve source_request_id, original timestamps and
-- variation rows. Clients cannot supply or alter the inverse operation.
create table planner_private.planner_undo_receipts(
 token uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 before_rows jsonb not null,after_rows jsonb not null,source_requests jsonb not null,
 created_at timestamptz not null default now(),used_at timestamptz
);
alter table planner_private.planner_undo_receipts enable row level security;
revoke all on planner_private.planner_undo_receipts from public,anon,authenticated;
create function planner_private.undo_rows(p_oid uuid,p_ids text[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('shifts',coalesce((select jsonb_agg(to_jsonb(s)||case when t.id is null then '{}'::jsonb else jsonb_build_object('preset_color',t.color)||case when t.deleted_at is null then jsonb_build_object('type',t.name,'preset_name',t.name) else '{}'::jsonb end end order by s.id) from public.shifts s left join lateral (select * from public.shift_templates t where t.organization_id=s.organization_id and t.branch_id=s.branch_id and (t.id::text=s.preset_id or t.legacy_preset_id=s.preset_id) order by (t.id::text=s.preset_id) desc limit 1) t on true where s.organization_id=p_oid and s.id=any(p_ids)),'[]'),
 'variations',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.attendance_variations v where v.organization_id=p_oid and v.shift_id=any(p_ids)),'[]'),
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'home_branch_id',e.home_branch_id,'branch_ids',coalesce((select jsonb_agg(a.branch_id order by a.branch_id) from public.employee_branch_assignments a where a.organization_id=p_oid and a.employee_id=e.id),'[]')) order by e.id) from public.employees e where e.organization_id=p_oid and e.id in(select left(x,length(x)-11) from unnest(p_ids) x)),'[]'));
$$;
revoke all on function planner_private.undo_rows(uuid,text[]) from public,anon,authenticated;

-- Capture request provenance even when the operation deletes the last linked
-- shift. The full server-owned row includes status, version and approved outcome.
create function planner_private.undo_requests(p_oid uuid,p_rows jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.requests r
 where r.organization_id=p_oid and r.id in(
  select (v->>'source_request_id')::uuid from jsonb_array_elements(p_rows->'shifts') v
  where v->>'source_request_id' is not null)
$$;
revoke all on function planner_private.undo_requests(uuid,jsonb) from public,anon,authenticated;

alter function public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]) rename to planner_apply_branch_operations_028;
revoke all on function public.planner_apply_branch_operations_028(uuid,jsonb,jsonb,uuid[]) from public,anon,authenticated;
create function public.planner_apply_branch_operations(p_organization_id uuid,p_operations jsonb,p_expected_revisions jsonb,p_branch_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op jsonb; bid uuid; rev bigint; rest jsonb; before_rows jsonb; ids text[]; receipt_token uuid; undoable boolean;
begin
 perform planner_private.lock_member(p_organization_id);
 if jsonb_typeof(p_operations) is distinct from 'array' or jsonb_array_length(p_operations)>5000 then raise exception 'Invalid operations';end if;
 for bid in select distinct (v->>'branchId')::uuid from jsonb_array_elements(p_operations) v order by 1 loop
  perform planner_private.lock_branch_operator(p_organization_id,bid,false);
  perform planner_private.ensure_branch_state(p_organization_id,bid);
  select revision into rev from public.branch_planner_state where organization_id=p_organization_id and branch_id=bid for update;
  if rev is distinct from (p_expected_revisions->>bid::text)::bigint then raise exception 'Branch revision conflict' using errcode='40001';end if;
 end loop;
 undoable:=jsonb_array_length(p_operations)>0 and not exists(select 1 from jsonb_array_elements(p_operations) v where v->>'kind' not in ('shift_upsert','shift_delete','variation_upsert','variation_delete'));
 select array_agg(distinct v->>'id') into ids from jsonb_array_elements(p_operations) v;
 if undoable then before_rows:=planner_private.undo_rows(p_organization_id,ids);end if;
 for op in select value from jsonb_array_elements(p_operations) loop
  if op->>'kind'='status_style_delete' then
   delete from public.branch_status_styles where organization_id=p_organization_id and branch_id=(op->>'branchId')::uuid and status=op->>'status';
  elsif op->>'kind'='status_style_upsert' then
   insert into public.branch_status_styles(organization_id,branch_id,status,name,color)
   values(p_organization_id,(op->>'branchId')::uuid,op->>'status',op->>'name',op->>'color')
   on conflict(organization_id,branch_id,status) do update set name=excluded.name,color=excluded.color;
  end if;
 end loop;
 select coalesce(jsonb_agg(v),'[]') into rest from jsonb_array_elements(p_operations) v where v->>'kind' not in ('status_style_upsert','status_style_delete');
 perform public.planner_apply_branch_operations_028(p_organization_id,rest,p_expected_revisions,null);
 for bid in select distinct (v->>'branchId')::uuid from jsonb_array_elements(p_operations) v where v->>'kind' in ('status_style_upsert','status_style_delete') loop
  if not exists(select 1 from jsonb_array_elements(rest) v where v->>'branchId'=bid::text) then perform planner_private.bump_branch_revision(p_organization_id,bid);end if;
 end loop;
 if jsonb_array_length(p_operations)>jsonb_array_length(rest) then perform planner_private.bump_revision(p_organization_id);end if;
 if undoable then
  -- Bounded retention of abandoned session receipts; keep latest 50 per user.
  delete from planner_private.planner_undo_receipts where organization_id=p_organization_id and user_id=auth.uid() and
   (created_at<now()-interval '1 day' or used_at is not null or token in(select token from planner_private.planner_undo_receipts where organization_id=p_organization_id and user_id=auth.uid() order by created_at desc,token offset 49));
  insert into planner_private.planner_undo_receipts(organization_id,user_id,before_rows,after_rows,source_requests)
   values(p_organization_id,auth.uid(),before_rows,planner_private.undo_rows(p_organization_id,ids),planner_private.undo_requests(p_organization_id,before_rows)) returning planner_undo_receipts.token into receipt_token;
 end if;
 return public.planner_load_scoped(p_organization_id,p_branch_ids)||jsonb_build_object('planner_change_date',to_char(timezone(coalesce((select v->>'timeZone' from jsonb_array_elements(p_operations) v where v->>'updateFutureTimes'='true' limit 1),'UTC'),now())::date,'YYYY-MM-DD'))||case when receipt_token is not null then jsonb_build_object('undo_token',receipt_token) else '{}' end;
end $$;
revoke all on function public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]) from public,anon;
grant execute on function public.planner_apply_branch_operations(uuid,jsonb,jsonb,uuid[]) to authenticated;

create function public.planner_undo(p_organization_id uuid,p_token uuid,p_expected_revisions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare receipt planner_private.planner_undo_receipts; ids text[]; row_value jsonb; old_row jsonb; bid uuid; rev bigint; source public.requests;
begin
 perform planner_private.lock_member(p_organization_id);
 select * into receipt from planner_private.planner_undo_receipts where token=p_token and organization_id=p_organization_id and user_id=auth.uid() and used_at is null and created_at>now()-interval '1 day' for update;
 if not found then raise exception 'Undo unavailable' using errcode='40001';end if;
 select array_agg(distinct v->>'id') into ids from jsonb_array_elements((receipt.before_rows->'shifts')||(receipt.after_rows->'shifts')||(receipt.before_rows->'variations')||(receipt.after_rows->'variations')) v;
 for bid in select distinct (v->>'branch_id')::uuid from jsonb_array_elements((receipt.before_rows->'shifts')||(receipt.after_rows->'shifts')) v order by 1 loop
  perform planner_private.lock_branch_operator(p_organization_id,bid,false);
  perform planner_private.ensure_branch_state(p_organization_id,bid);
  select revision into rev from public.branch_planner_state where organization_id=p_organization_id and branch_id=bid for update;
  if rev is distinct from (p_expected_revisions->>bid::text)::bigint then raise exception 'Branch revision conflict' using errcode='40001';end if;
 end loop;
 -- Follow the existing request-revoke lock order: branch state, then requests.
 -- Locks prevent cancellation/revocation racing between validation and insert.
 for source in select * from public.requests where organization_id=p_organization_id
  and id in(select (v->>'id')::uuid from jsonb_array_elements(receipt.source_requests) v) order by id for update loop
  perform planner_private.lock_branch_operator(p_organization_id,source.approval_branch_id,false);
 end loop;
 if planner_private.undo_requests(p_organization_id,receipt.before_rows) is distinct from receipt.source_requests then
  raise exception 'Undo conflicts with changed request status or version' using errcode='40001';
 end if;
 for row_value in select value from jsonb_array_elements(receipt.before_rows->'shifts') where value->>'source_request_id' is not null loop
  select * into source from public.requests where organization_id=p_organization_id and id=(row_value->>'source_request_id')::uuid;
  if source.id is null or source.status<>'approved' or coalesce(source.approved_type,source.type)<>'Ferie'
   or source.employee_id is distinct from row_value->>'employee_id'
   or source.approval_branch_id is distinct from (row_value->>'branch_id')::uuid
   or (row_value->>'date')::date not between coalesce(source.approved_start_date,source.start_date) and coalesce(source.approved_end_date,source.end_date)
   or not exists(select 1 from public.request_shift_changes c where c.organization_id=p_organization_id and c.request_id=source.id
    and c.employee_id=source.employee_id and c.shift_date=(row_value->>'date')::date and c.restored_at is null
    and (c.applied_shift-array['created_at','updated_at'])=(row_value-array['created_at','updated_at'])) then
   raise exception 'Undo conflicts with invalid source request' using errcode='40001';
  end if;
 end loop;
 if planner_private.undo_rows(p_organization_id,ids) is distinct from receipt.after_rows then raise exception 'Undo conflicts with later changes' using errcode='40001';end if;
 -- Explicit archive check: the legacy guard can silently skip an UPDATE.
 for row_value in select value from jsonb_array_elements((receipt.before_rows->'shifts')||(receipt.after_rows->'shifts')) loop
  if not planner_private.archive_month_allowed((row_value->>'date')::date) then raise exception 'Archived month is read only' using errcode='42501';end if;
 end loop;
 -- Both authorization and saved inverse rows are derived on the server.
 -- Restore only touched IDs, never whole snapshots, employees, users or settings.
 delete from public.attendance_variations where organization_id=p_organization_id and shift_id=any(ids);
 delete from public.shifts where organization_id=p_organization_id and id=any(ids);
 for row_value in select value from jsonb_array_elements(receipt.before_rows->'shifts') loop
  -- The receipt also compares employee assignments. A legitimately approved
  -- external shift can be restored without inventing a new branch assignment.
  if not exists(select 1 from public.employees where organization_id=p_organization_id and id=row_value->>'employee_id') then raise exception 'Employee changed' using errcode='40001';end if;
  insert into public.shifts select (jsonb_populate_record(null::public.shifts,row_value)).*;
 end loop;
 for row_value in select value from jsonb_array_elements(receipt.before_rows->'variations') loop
  insert into public.attendance_variations select (jsonb_populate_record(null::public.attendance_variations,row_value)).*;
 end loop;
 if planner_private.undo_rows(p_organization_id,ids) is distinct from receipt.before_rows then raise exception 'Undo state changed' using errcode='40001';end if;
 update planner_private.planner_undo_receipts set used_at=now() where token=p_token;
 for bid in select distinct (v->>'branch_id')::uuid from jsonb_array_elements((receipt.before_rows->'shifts')||(receipt.after_rows->'shifts')) v loop perform planner_private.bump_branch_revision(p_organization_id,bid);end loop;
 perform planner_private.bump_revision(p_organization_id);
 return public.planner_load_scoped(p_organization_id,null);
end $$;
revoke all on function public.planner_undo(uuid,uuid,jsonb) from public,anon;
grant execute on function public.planner_undo(uuid,uuid,jsonb) to authenticated;

-- CAS protects a personal order against another tab/device, including Undo.
create function public.user_branch_employee_order_save(p_organization_id uuid,p_branch_id uuid,p_expected_order text[],p_employee_order text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare current_order text[];
begin
 perform planner_private.lock_member(p_organization_id);
 if not planner_private.can_read_template_branch(p_organization_id,p_branch_id) then raise exception 'Branch scope denied' using errcode='42501';end if;
 select employee_order into current_order from public.user_branch_planner_preferences where organization_id=p_organization_id and user_id=auth.uid() and branch_id=p_branch_id;
 if current_order is distinct from p_expected_order then raise exception 'Employee order conflict' using errcode='40001';end if;
 if p_employee_order is null then
  update public.user_branch_planner_preferences set employee_order=null,updated_at=now() where organization_id=p_organization_id and user_id=auth.uid() and branch_id=p_branch_id;
  return public.user_planner_preferences();
 end if;
 return public.user_branch_planner_preferences_save(p_organization_id,p_branch_id,p_employee_order,null,null);
end $$;
revoke all on function public.user_branch_employee_order_save(uuid,uuid,text[],text[]) from public,anon;
grant execute on function public.user_branch_employee_order_save(uuid,uuid,text[],text[]) to authenticated;
-- Preserve status styles in full backup import/restore as well as scoped writes.
alter function public.planner_save(jsonb,bigint,boolean) rename to planner_save_028;
revoke all on function public.planner_save_028(jsonb,bigint,boolean) from public,anon,authenticated;
create function public.planner_save(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); branch_styles record; style record;
begin
 perform public.planner_save_028(payload,expected_revision,only_empty);
 if payload#>'{settings,statusStyles}' is not null and jsonb_typeof(payload#>'{settings,statusStyles}') is distinct from 'object' then raise exception 'Invalid status styles';end if;
 delete from public.branch_status_styles where organization_id=oid;
 for branch_styles in select key,value from jsonb_each(coalesce(payload#>'{settings,statusStyles}','{}')) loop
  perform planner_private.lock_branch_operator(oid,branch_styles.key::uuid,false);
  for style in select key,value from jsonb_each(branch_styles.value) loop
   insert into public.branch_status_styles(organization_id,branch_id,status,name,color)
   values(oid,branch_styles.key::uuid,style.key,style.value->>'name',style.value->>'color');
  end loop;
 end loop;
 return public.planner_load();
end $$;
revoke all on function public.planner_save(jsonb,bigint,boolean) from public,anon;
grant execute on function public.planner_save(jsonb,bigint,boolean) to authenticated;
-- Gate every authenticated public mutation entry point BEFORE its body runs,
-- including legacy RPC aliases, account/onboarding, requests, archive operations
-- and personal preferences. Read RPCs keep their existing authorization and may
-- perform server maintenance (archive refresh / branch-state initialization).
-- Preserve function OIDs, defaults, grants and internal callers via replacement.
do $$
declare f record; body text; relation regclass;
begin
 for f in select p.oid,p.proname,p.prosrc,pg_get_function_arguments(p.oid) args,pg_get_function_result(p.oid) result
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and has_function_privilege('authenticated',p.oid,'EXECUTE')
   and p.prorettype<>'trigger'::regtype and p.proname<>all(array[
    'account_context','current_organization_id','organization_members','organization_invite_check','organization_invite_resolve',
    'organization_invite_list','access_invite_list','branch_list','branch_invite_list','branch_access_overview',
    'employee_branch_assignment_overview','cross_branch_shift_list','planner_load','planner_load_scoped','planner_load_scoped_020',
    'user_planner_preferences','request_list','request_approval_preview','note_unread_state','request_unread_state','archive_list','planner_client_compatibility'])
 loop
  if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=f.oid and l.lanname='plpgsql' and p.prosecdef and p.provolatile='v') then
   raise exception 'Unclassified mutation RPC: %',f.proname;
  end if;
  body:=regexp_replace(f.prosrc,'\m[Bb][Ee][Gg][Ii][Nn]\M','begin perform planner_private.assert_client_write();');
  if body=f.prosrc then raise exception 'Cannot gate mutation RPC: %',f.proname;end if;
  execute format('create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path=%L as %L',f.proname,f.args,f.result,'',body);
 end loop;
 -- Direct Data API writes have no bypass: all public application tables are RPC
 -- owned. Revoke DML explicitly rather than relying on RLS alone.
 revoke insert,update,delete,truncate,references,trigger on all tables in schema public from public,anon,authenticated;
 -- Every application table is guarded. Only the explicit trusted read routes
 -- above can perform read-time initialization/materialization while closed.
 for relation in select c.oid::regclass from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' loop
  execute format('create trigger client_write_gate before insert or update or delete or truncate on %s for each statement execute function planner_private.guard_client_write()',relation);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
