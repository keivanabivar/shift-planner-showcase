-- Request reversal/adjustments, hourly permissions, dated templates and per-user note receipts.
-- Apply once after 007_viewer_shared_notes_requests.sql.
begin;

do $$ begin
 if to_regclass('public.requests') is null or to_regprocedure('public.request_list(uuid)') is null then
  raise exception '008 requires migrations 001 through 007';
 end if;
end $$;

alter table public.requests drop constraint requests_status_check;
alter table public.requests add constraint requests_status_check check(status in ('pending','approved','rejected','cancelled','revoked'));
alter table public.requests
 add column approved_type text check(approved_type in ('Ferie','Permesso','Cambio turno','Indisponibilità','Altro')),
 add column approved_start_date date,
 add column approved_end_date date,
 add column approved_start_time time,
 add column approved_end_time time,
 add column adjusted boolean not null default false,
 add column revoked_by_user_id uuid references auth.users(id) on delete set null,
 add column revoked_at timestamptz,
 add column revocation_note text not null default '';
alter table public.requests add constraint requests_approved_details check(
 (approved_type is null and approved_start_date is null and approved_end_date is null and approved_start_time is null and approved_end_time is null)
 or (approved_type is not null and approved_start_date is not null and approved_end_date is not null
  and approved_end_date>=approved_start_date and approved_end_date-approved_start_date<=365
  and ((approved_start_time is null and approved_end_time is null) or (approved_start_time is not null and approved_end_time is not null and approved_start_time<>approved_end_time))
  and (approved_type<>'Ferie' or (approved_start_time is null and approved_end_time is null)))
);
alter table public.requests add constraint requests_revocation_valid check(
 length(revocation_note)<=4000 and (status<>'revoked' or revoked_at is not null)
);

update public.notes set date=created_at::date where date is null;
alter table public.notes alter column date set not null;
alter table public.notes add column updated_by_user_id uuid references auth.users(id) on delete set null;
create table public.note_reads(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(organization_id,user_id)
);
alter table public.note_reads enable row level security;
revoke all on public.note_reads from public,anon,authenticated;

create table public.shift_template_versions(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 effective_from date not null,
 mattina_start time not null,mattina_end time not null,
 pomeriggio_start time not null,pomeriggio_end time not null,
 changed_by_user_id uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 check(mattina_start<>mattina_end and pomeriggio_start<>pomeriggio_end)
);
create index shift_template_versions_tenant_date on public.shift_template_versions(organization_id,effective_from desc,created_at desc);
alter table public.shift_template_versions enable row level security;
revoke all on public.shift_template_versions from public,anon,authenticated;
grant select on public.shift_template_versions to authenticated;
create policy writer_template_read on public.shift_template_versions for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(
  select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.organization_id=shift_template_versions.organization_id and p.is_active and p.role in ('admin','editor'))
);

-- Preserve historical built-in shifts while reusing the fully validated snapshot writer.
-- Rows that intentionally differ from the current template are validated as explicit
-- shifts during the inner save, then restored to their semantic type before returning.
create function public.planner_save_effective(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); compatible jsonb:=payload; k text; v jsonb; changed_notes text[]; before_settings jsonb; result jsonb; effective date;
begin
 if oid is null or auth.uid() is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform planner_private.lock_member(oid,'writer');
 effective:=coalesce(nullif(payload->'settings'->>'templateEffectiveFrom','')::date,current_date);
 if not isfinite(effective) then raise exception 'Invalid effective date'; end if;
 if exists(select 1 from jsonb_array_elements(payload->'notes') n where nullif(n->>'date','') is null) then raise exception 'Note date is required'; end if;
 select value into before_settings from public.settings where organization_id=oid and id=true;
 select coalesce(array_agg(n->>'id'),'{}') into changed_notes from jsonb_array_elements(payload->'notes') n
 left join public.notes old on old.organization_id=oid and old.id=n->>'id'
 where old.id is null or old.text is distinct from n->>'text' or old.date is distinct from (n->>'date')::date or coalesce(old.employee_id,'') is distinct from coalesce(n->>'employeeId','');
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  if v->>'type' in ('Mattina','Pomeriggio') and
   (v->>'start' is distinct from payload->'settings'->'presets'->(v->>'type')->>'start' or v->>'end' is distinct from payload->'settings'->'presets'->(v->>'type')->>'end') then
   compatible:=jsonb_set(compatible,array['data','shifts',k,'type'],'"Centrale"'::jsonb,false);
  end if;
 end loop;
 result:=public.planner_save(compatible,expected_revision,only_empty);
 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  if v->>'type' in ('Mattina','Pomeriggio') then update public.shifts set type=v->>'type' where organization_id=oid and id=k; end if;
 end loop;
 update public.notes set updated_by_user_id=auth.uid() where organization_id=oid and id=any(changed_notes);
 if before_settings is null or before_settings->'presets'->'Mattina' is distinct from payload->'settings'->'presets'->'Mattina'
 or before_settings->'presets'->'Pomeriggio' is distinct from payload->'settings'->'presets'->'Pomeriggio' then
  insert into public.shift_template_versions(organization_id,effective_from,mattina_start,mattina_end,pomeriggio_start,pomeriggio_end,changed_by_user_id)
  values(oid,effective,(payload->'settings'->'presets'->'Mattina'->>'start')::time,(payload->'settings'->'presets'->'Mattina'->>'end')::time,
   (payload->'settings'->'presets'->'Pomeriggio'->>'start')::time,(payload->'settings'->'presets'->'Pomeriggio'->>'end')::time,auth.uid());
 end if;
 return public.planner_load();
end $$;

create function public.note_unread_state(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; last_read timestamptz;
begin
 m:=planner_private.lock_member(p_organization_id);
 select read_at into last_read from public.note_reads where organization_id=p_organization_id and user_id=m.user_id;
 return jsonb_build_object('organization_id',p_organization_id,'unread',exists(
  select 1 from public.notes n where n.organization_id=p_organization_id and n.updated_at>coalesce(last_read,'-infinity'::timestamptz)
  and n.updated_by_user_id is distinct from m.user_id));
end $$;
create function public.note_mark_read(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; stamp timestamptz:=clock_timestamp();
begin
 m:=planner_private.lock_member(p_organization_id);
 insert into public.note_reads(organization_id,user_id,read_at) values(p_organization_id,m.user_id,stamp)
 on conflict(organization_id,user_id) do update set read_at=excluded.read_at;
 return jsonb_build_object('organization_id',p_organization_id,'read_at',stamp,'unread',false);
end $$;

-- New overload accepts the manager-approved outcome while retaining the original request.
create function public.request_approve(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint,p_confirm_replace boolean,p_note text,p_approved_type text,p_approved_start_date date,
 p_approved_end_date date,p_approved_start_time time default null,p_approved_end_time time default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; d date; sid text; prev jsonb; variation jsonb; applied jsonb; adjusted_value boolean;
begin
 perform planner_private.lock_member(p_organization_id,'writer');perform planner_private.check_revision(p_organization_id,p_expected_revision);
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found or r.status<>'pending' then raise exception 'Pending request not found'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 perform planner_private.validate_request(p_approved_type,p_approved_start_date,p_approved_end_date,p_approved_start_time,p_approved_end_time,p_note);
 adjusted_value:=(p_approved_type,p_approved_start_date,p_approved_end_date,p_approved_start_time,p_approved_end_time) is distinct from (r.type,r.start_date,r.end_date,r.start_time,r.end_time);
 if p_approved_type='Ferie' then
  if exists(select 1 from public.requests q where q.organization_id=p_organization_id and q.employee_id=r.employee_id and q.id<>r.id
   and coalesce(q.approved_type,q.type)='Ferie' and q.status='approved' and coalesce(q.approved_start_date,q.start_date)<=p_approved_end_date and coalesce(q.approved_end_date,q.end_date)>=p_approved_start_date)
   then raise exception 'Overlapping approved Ferie must be revoked first'; end if;
  if not p_confirm_replace and exists(select 1 from public.shifts where organization_id=p_organization_id and employee_id=r.employee_id and date between p_approved_start_date and p_approved_end_date)
   then return jsonb_build_object('ok',false,'code','confirmation_required','request',to_jsonb(r)); end if;
  for d in select p_approved_start_date+n from generate_series(0,p_approved_end_date-p_approved_start_date) n loop
   sid:=r.employee_id||'|'||d::text;select to_jsonb(s) into prev from public.shifts s where organization_id=p_organization_id and id=sid;
   select to_jsonb(v) into variation from public.attendance_variations v where organization_id=p_organization_id and shift_id=sid;
   delete from public.attendance_variations where organization_id=p_organization_id and shift_id=sid;
   insert into public.shifts(organization_id,id,employee_id,date,type,source_request_id) values(p_organization_id,sid,r.employee_id,d,'Ferie',r.id)
   on conflict(organization_id,id) do update set type='Ferie',start_time=null,end_time=null,preset_id=null,preset_name=null,preset_color=null,source_request_id=excluded.source_request_id,updated_at=now();
   update public.shifts set source_request_id=r.id where organization_id=p_organization_id and id=sid;
   select to_jsonb(s) into applied from public.shifts s where organization_id=p_organization_id and id=sid;
   insert into public.request_shift_changes(organization_id,request_id,employee_id,shift_date,previous_shift,previous_variation,applied_shift) values(p_organization_id,r.id,r.employee_id,d,prev,variation,applied);
  end loop;perform planner_private.bump_revision(p_organization_id);
 end if;
 update public.requests set status='approved',decided_by_user_id=auth.uid(),decided_at=now(),decision_note=p_note,
  approved_type=p_approved_type,approved_start_date=p_approved_start_date,approved_end_date=p_approved_end_date,
  approved_start_time=p_approved_start_time,approved_end_time=p_approved_end_time,adjusted=adjusted_value,version=version+1,updated_at=now()
 where id=r.id returning * into r;perform planner_private.request_event(r,case when adjusted_value then 'approved_adjusted' else 'approved' end);
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',(select revision from public.planner_state where organization_id=p_organization_id and id=true));
end $$;

create function public.request_revoke(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint,p_restore boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; b public.request_shift_changes; conflicts jsonb;
begin
 perform planner_private.lock_member(p_organization_id,'writer');select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found or r.status<>'approved' then raise exception 'Approved request not found'; end if;
 if r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if p_note is null or length(p_note)>4000 or p_restore is null then raise exception 'Invalid revocation'; end if;
 if coalesce(r.approved_type,r.type)='Ferie' then
  perform planner_private.check_revision(p_organization_id,p_expected_revision);
  if p_restore then
   select coalesce(jsonb_agg(bc.shift_date order by bc.shift_date),'[]'::jsonb) into conflicts from public.request_shift_changes bc
   left join public.shifts s on s.organization_id=bc.organization_id and s.id=bc.employee_id||'|'||bc.shift_date::text
   where bc.organization_id=p_organization_id and bc.request_id=r.id and (s.source_request_id is distinct from r.id
    or (to_jsonb(s)-array['created_at','updated_at']) is distinct from (bc.applied_shift-array['created_at','updated_at'])
    or exists(select 1 from public.attendance_variations v where v.organization_id=p_organization_id and v.shift_id=s.id));
   if jsonb_array_length(conflicts)>0 then return jsonb_build_object('ok',false,'code','restoration_conflict','dates',conflicts,'request',to_jsonb(r)); end if;
   for b in select * from public.request_shift_changes where organization_id=p_organization_id and request_id=r.id order by shift_date loop
    delete from public.shifts where organization_id=p_organization_id and id=b.employee_id||'|'||b.shift_date::text;
    if b.previous_shift is not null then insert into public.shifts select (jsonb_populate_record(null::public.shifts,b.previous_shift||jsonb_build_object('source_request_id',null))).*; end if;
    if b.previous_variation is not null then insert into public.attendance_variations select (jsonb_populate_record(null::public.attendance_variations,b.previous_variation)).*; end if;
   end loop;update public.request_shift_changes set restored_at=now() where organization_id=p_organization_id and request_id=r.id;
  else update public.shifts set source_request_id=null where organization_id=p_organization_id and source_request_id=r.id;end if;
  perform planner_private.bump_revision(p_organization_id);
 end if;
 update public.requests set status='revoked',revoked_by_user_id=auth.uid(),revoked_at=now(),revocation_note=p_note,
  restoration=case when coalesce(r.approved_type,r.type)='Ferie' then case when p_restore then 'restored' else 'kept' end else null end,
  version=version+1,updated_at=now() where id=r.id returning * into r;perform planner_private.request_event(r,'revoked');
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',(select revision from public.planner_state where organization_id=p_organization_id and id=true));
end $$;

revoke all on function public.planner_save_effective(jsonb,bigint,boolean),public.note_unread_state(uuid),public.note_mark_read(uuid),
 public.request_approve(uuid,uuid,bigint,bigint,boolean,text,text,date,date,time,time),public.request_revoke(uuid,uuid,bigint,bigint,boolean,text)
 from public,anon,authenticated;
grant execute on function public.planner_save_effective(jsonb,bigint,boolean),public.note_unread_state(uuid),public.note_mark_read(uuid),
 public.request_approve(uuid,uuid,bigint,bigint,boolean,text,text,date,date,time,time),public.request_revoke(uuid,uuid,bigint,bigint,boolean,text)
 to authenticated;
notify pgrst, 'reload schema';
commit;
