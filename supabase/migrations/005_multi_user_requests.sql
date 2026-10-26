-- 005_multi_user_requests.sql
-- Apply ONCE, after the four supplied 001..004 migrations, as the migration owner.
-- PostgreSQL 15+ / Supabase. No Auth admin API or service_role key required.
-- Does not apply itself. All changes are transactional; no existing records are deleted.
-- API contracts, UI integration, and test/deployment notes: 005_deployment_checklist.md.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
lock table public.planner_state, public.profiles, public.organizations,
 public.employees, public.shifts, public.attendance_variations,
 public.notes, public.settings in access exclusive mode;

-- Fail safely on a missing prerequisite or an accidental second run.
do $$ begin
 if to_regprocedure('public.planner_save_v3(jsonb,bigint,boolean)') is null
 or not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='shifts' and column_name='preset_color') then
  raise exception '005 requires the supplied migrations 001 through 004';
 end if;
 if to_regclass('public.requests') is not null then
  raise exception '005 already applied, or public.requests exists: inspect before proceeding';
 end if;
end $$;

create schema planner_private;
revoke all on schema planner_private from public,anon,authenticated;
alter table public.profiles drop constraint profiles_role_check;
update public.profiles set role='editor' where role='manager';
alter table public.profiles add constraint profiles_role_check check(role in ('admin','editor','viewer'));
alter table public.profiles add column employee_id text, add column is_active boolean not null default true;
alter table public.profiles add constraint profiles_employee_fk foreign key(organization_id,employee_id)
 references public.employees(organization_id,id) on delete set null (employee_id);
-- One login per linked employee, including inactive memberships. Explicitly unlink
-- an inactive membership before reassigning its employee to a different login.
create unique index profiles_employee_unique on public.profiles(organization_id,employee_id) where employee_id is not null;

create or replace function public.current_organization_id() returns uuid
language sql stable security definer set search_path='' as $$
 select organization_id from public.profiles where user_id=auth.uid() and is_active
 and role in ('admin','editor','viewer')
$$;
create function planner_private.member_role() returns text
language sql stable security definer set search_path='' as $$
 select role from public.profiles where user_id=auth.uid() and is_active
$$;
-- Every application mutation uses the SAME tenant state lock, then rechecks
-- membership. Revocation/demotion and concurrent saves therefore serialize.
create function planner_private.lock_member(p_organization_id uuid,p_access text default 'member')
returns public.profiles language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 if auth.uid() is null or p_organization_id is null
 or public.current_organization_id() is distinct from p_organization_id then
  raise exception 'Access denied or organization changed' using errcode='42501';
 end if;
 perform 1 from public.planner_state where organization_id=p_organization_id and id=true for update;
 if not found then raise exception 'Organization state missing'; end if;
 select * into m from public.profiles where user_id=auth.uid() and is_active;
 if m.organization_id is distinct from p_organization_id
 or (p_access='writer' and m.role not in ('admin','editor'))
 or (p_access='admin' and m.role<>'admin')
 or p_access not in ('member','writer','admin') then
  raise exception 'Access denied' using errcode='42501';
 end if;
 return m;
end $$;
create function planner_private.check_revision(p_oid uuid,p_revision bigint) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_revision is null or p_revision is distinct from
 (select revision from public.planner_state where organization_id=p_oid and id=true) then
  raise exception 'Revision conflict; reload planner and preview again' using errcode='40001';
 end if;
end $$;
create function planner_private.bump_revision(p_oid uuid) returns bigint
language sql security definer set search_path='' as $$
 update public.planner_state set revision=revision+1 where organization_id=p_oid and id=true returning revision
$$;

-- Replace permissive FOR ALL policies with SELECT-only policies. Even an
-- accidental future table-write grant will not bypass RPC serialization.
do $$ declare p record; t text; begin
 for p in select tablename,policyname from pg_policies where schemaname='public'
 and tablename in ('employees','shifts','attendance_variations','notes','settings','planner_state','profiles','organizations','planner_access') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;

 -- All active tenant members, including viewers, may read schedule data.
 foreach t in array array['employees','shifts','settings','planner_state'] loop
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format(
   'create policy active_tenant_read on public.%I for select to authenticated using (organization_id=(select public.current_organization_id()))',
   t
  );
 end loop;

 -- Notes and attendance details are managerial data: admin/editor only.
 foreach t in array array['attendance_variations','notes'] loop
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format(
   'create policy writer_tenant_read on public.%I for select to authenticated using (
      organization_id=(select public.current_organization_id())
      and exists (
       select 1 from public.profiles p
       where p.user_id=(select auth.uid())
         and p.organization_id=%I.organization_id
         and p.is_active
         and p.role in (''admin'',''editor'')
      )
    )',
   t,t
  );
 end loop;
end $$;
revoke all on public.profiles,public.organizations,public.planner_access from public,anon,authenticated;
grant select on public.profiles,public.organizations to authenticated;
create policy active_organization_read on public.organizations for select to authenticated using(id=(select public.current_organization_id()));
create policy own_active_profile on public.profiles for select to authenticated
 using(user_id=(select auth.uid()) and is_active and organization_id=(select public.current_organization_id()));

create or replace function public.account_context() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',p.user_id,'organization_id',p.organization_id,
 'organization_name',o.name,'full_name',p.full_name,'role',p.role,
 'employee_id',p.employee_id,'is_active',p.is_active)
 from public.profiles p join public.organizations o on o.id=p.organization_id
 where p.user_id=auth.uid() and p.is_active
$$;
create or replace function public.account_update(manager_name text,organization_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; n text;
begin
 m:=planner_private.lock_member(public.current_organization_id());
 if manager_name is null or length(trim(manager_name)) not between 1 and 200
 or organization_name is null or length(trim(organization_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 select name into n from public.organizations where id=m.organization_id;
 if trim(organization_name) is distinct from n and m.role<>'admin' then
  raise exception 'Only administrators may rename the organization' using errcode='42501';
 end if;
 update public.profiles set full_name=trim(manager_name),updated_at=now() where user_id=m.user_id;
 if trim(organization_name) is distinct from n then
  update public.organizations set name=trim(organization_name),updated_at=now() where id=m.organization_id;
 end if;
 return public.account_context();
end $$;
create or replace function public.account_update(manager_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(public.current_organization_id());
 if manager_name is null or length(trim(manager_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 update public.profiles set full_name=trim(manager_name),updated_at=now() where user_id=m.user_id;
 return public.account_context();
end $$;
create function public.organization_members(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 return coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.user_id)
 from public.profiles p where organization_id=p_organization_id),'[]'::jsonb);
end $$;
create function public.organization_member_update(p_organization_id uuid,p_user_id uuid,
 p_role text,p_employee_id text,p_is_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target public.profiles;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_role is null or p_role not in ('admin','editor','viewer') or p_is_active is null then raise exception 'Invalid membership'; end if;
 select * into target from public.profiles where user_id=p_user_id and organization_id=p_organization_id;
 if not found then raise exception 'Member not found'; end if;
 if target.role='admin' and target.is_active and (p_role<>'admin' or not p_is_active)
 and not exists(select 1 from public.profiles where organization_id=p_organization_id
   and role='admin' and is_active and user_id<>p_user_id) then raise exception 'Cannot remove the last active admin'; end if;
 update public.profiles set role=p_role,employee_id=p_employee_id,is_active=p_is_active,updated_at=now()
 where user_id=p_user_id returning * into target;
 return to_jsonb(target);
end $$;

create table public.user_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 shift_color_overrides jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
create function planner_private.valid_colors(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if v is null or jsonb_typeof(v)<>'object' or octet_length(v::text)>32768 then return false; end if;
 return not exists(select 1 from jsonb_each(v) where length(key) not between 1 and 200
 or jsonb_typeof(value)<>'string' or (value#>>'{}') !~ '^#[0-9a-fA-F]{6}$');
end $$;
alter table public.user_preferences add constraint valid_shift_colors check(planner_private.valid_colors(shift_color_overrides));
alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from public,anon,authenticated;
grant select on public.user_preferences to authenticated;
create policy own_preferences on public.user_preferences for select to authenticated
 using(user_id=(select auth.uid()) and organization_id=(select public.current_organization_id()));
create function public.user_preferences_save(p_organization_id uuid,p_colors jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.user_preferences;
begin
 perform planner_private.lock_member(p_organization_id);
 if not planner_private.valid_colors(p_colors) then raise exception 'Invalid colors'; end if;
 insert into public.user_preferences(user_id,organization_id,shift_color_overrides)
 values(auth.uid(),p_organization_id,p_colors) on conflict(user_id) do update
 set organization_id=excluded.organization_id,shift_color_overrides=excluded.shift_color_overrides,updated_at=now()
 returning * into result;
 return to_jsonb(result);
end $$;

create table public.organization_invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 email text not null check(email=lower(trim(email)) and length(email) between 3 and 320),
 role text not null check(role in ('admin','editor','viewer')),
 employee_id text,
 token_hash bytea not null unique check(octet_length(token_hash)=32),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),expires_at timestamptz not null,
 accepted_by uuid references auth.users(id) on delete set null, accepted_at timestamptz,
 revoked_at timestamptz,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete set null (employee_id),
 check(expires_at>created_at),check(not (accepted_at is not null and revoked_at is not null))
);
create unique index invitations_one_pending_email on public.organization_invitations(organization_id,email)
 where accepted_at is null and revoked_at is null;
alter table public.organization_invitations enable row level security;
-- No direct table SELECT: token hashes must never appear in the Data API.
revoke all on public.organization_invitations from public,anon,authenticated;
create function public.organization_invite_create(p_organization_id uuid,p_email text,
 p_role text default 'viewer',p_employee_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare token text; iid uuid; email_normalized text:=lower(trim(p_email));
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if email_normalized is null or email_normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 or length(email_normalized)>320 or p_role is null or p_role not in ('admin','editor','viewer') then raise exception 'Invalid invitation'; end if;
 if p_employee_id is not null and exists(select 1 from public.profiles
 where organization_id=p_organization_id and employee_id=p_employee_id) then raise exception 'Employee already linked'; end if;
 update public.organization_invitations set revoked_at=now()
 where organization_id=p_organization_id and email=email_normalized and accepted_at is null and revoked_at is null;
 token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.organization_invitations(organization_id,email,role,employee_id,token_hash,created_by,expires_at)
 values(p_organization_id,email_normalized,p_role,p_employee_id,sha256(convert_to(token,'UTF8')),auth.uid(),now()+interval '7 days')
 returning id into iid;
 return jsonb_build_object('id',iid,'token',token,'expires_at',now()+interval '7 days');
end $$;
create function public.organization_invite_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 return coalesce((select jsonb_agg(to_jsonb(i)-'token_hash' order by created_at desc)
 from public.organization_invitations i where organization_id=p_organization_id),'[]'::jsonb);
end $$;
create function public.organization_invite_revoke(p_organization_id uuid,p_invitation_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 update public.organization_invitations set revoked_at=coalesce(revoked_at,now())
 where id=p_invitation_id and organization_id=p_organization_id and accepted_at is null;
 if not found then raise exception 'Pending invitation not found'; end if;
end $$;
create function public.organization_invite_accept(p_token text,p_full_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.organization_invitations; uid uuid:=auth.uid(); user_email text;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation' using errcode='42501'; end if;
 -- Same first lock as organization_onboard: simultaneous acceptance/onboarding
 -- cannot create two memberships. The verified email comes from Auth, not JWT metadata.
 select lower(email) into user_email from auth.users where id=uid and email_confirmed_at is not null for update;
 if user_email is null then raise exception 'Confirmed email required' using errcode='42501'; end if;
 if exists(select 1 from public.profiles where user_id=uid) then
  raise exception 'Account already has a membership; contact an admin (no automatic tenant transfer)';
 end if;
 select * into i from public.organization_invitations where token_hash=sha256(convert_to(p_token,'UTF8'));
 if not found then raise exception 'Invalid invitation' using errcode='42501'; end if;
 perform 1 from public.planner_state where organization_id=i.organization_id and id=true for update;
 if not found then raise exception 'Organization state missing'; end if;
 select * into i from public.organization_invitations where id=i.id for update;
 if i.email is distinct from user_email or i.accepted_at is not null or i.revoked_at is not null
 or i.expires_at<=clock_timestamp() then raise exception 'Invalid or expired invitation' using errcode='42501'; end if;
 if p_full_name is null or length(trim(p_full_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 insert into public.profiles(user_id,organization_id,full_name,role,employee_id,is_active)
 values(uid,i.organization_id,trim(p_full_name),i.role,i.employee_id,true);
 update public.organization_invitations set accepted_by=uid,accepted_at=now() where id=i.id;
 return public.account_context();
end $$;

create table public.requests (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 employee_id text not null, employee_name text not null,
 created_by_user_id uuid references auth.users(id) on delete set null,
 created_by_name text not null,
 type text not null check(type in ('Ferie','Permesso','Cambio turno','Indisponibilità','Altro')),
 start_date date not null,end_date date not null,start_time time,end_time time,note text not null default '',
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled')),
 version bigint not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 decided_by_user_id uuid references auth.users(id) on delete set null,decided_at timestamptz,
 decision_note text not null default '',
 cancelled_by_user_id uuid references auth.users(id) on delete set null,cancelled_at timestamptz,
 cancellation_note text not null default '',
 restoration text check(restoration in ('restored','kept')),
 unique(organization_id,id),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 check(isfinite(start_date) and isfinite(end_date) and end_date>=start_date and end_date-start_date<=365),
 check((start_time is null and end_time is null) or (start_time is not null and end_time is not null and start_time<>end_time)),
 check(type<>'Ferie' or (start_time is null and end_time is null)),
 check(length(note)<=4000 and length(decision_note)<=4000 and length(cancellation_note)<=4000),
 check(version>0),
 check((status in ('pending','cancelled') or decided_at is not null)
  and (status<>'cancelled' or cancelled_at is not null))
);
create index requests_tenant_dates on public.requests(organization_id,start_date,end_date);
create index requests_tenant_employee_status on public.requests(organization_id,employee_id,status);
create index requests_creator on public.requests(created_by_user_id);
create table public.request_shift_changes (
 organization_id uuid not null,request_id uuid not null,employee_id text not null,shift_date date not null,
 previous_shift jsonb,previous_variation jsonb,applied_shift jsonb not null,
 created_at timestamptz not null default now(),restored_at timestamptz,
 primary key(organization_id,request_id,shift_date),
 foreign key(organization_id,request_id) references public.requests(organization_id,id) on delete restrict
);
create table public.request_events (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,request_id uuid not null,
 actor_user_id uuid references auth.users(id) on delete set null,
 actor_name text not null,action text not null,request_snapshot jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(organization_id,request_id) references public.requests(organization_id,id) on delete restrict
);
create index request_events_request on public.request_events(organization_id,request_id,created_at);
-- Provenance survives an unchanged full-snapshot save, but not a meaningful edit
-- or delete/recreate, even if the user later makes the row look like Ferie again.
alter table public.shifts add column source_request_id uuid;
alter table public.shifts add constraint shifts_source_request_fk foreign key(organization_id,source_request_id)
 references public.requests(organization_id,id) on delete restrict;
create function planner_private.clear_changed_shift_source() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.source_request_id is not null and
 (to_jsonb(new)-array['created_at','updated_at','source_request_id']) is distinct from
 (to_jsonb(old)-array['created_at','updated_at','source_request_id']) then new.source_request_id:=null; end if;
 return new;
end $$;
create trigger shifts_clear_changed_source before update on public.shifts
 for each row execute function planner_private.clear_changed_shift_source();

do $$ declare t text; begin
 -- All active tenant members, including viewers, may read requests.
 alter table public.requests enable row level security;
 revoke all on public.requests from public,anon,authenticated;
 grant select on public.requests to authenticated;
 create policy active_tenant_read on public.requests for select to authenticated
  using (organization_id=(select public.current_organization_id()));

 -- Internal audit/restoration history is admin/editor only.
 foreach t in array array['request_shift_changes','request_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format(
   'create policy writer_tenant_read on public.%I for select to authenticated using (
      organization_id=(select public.current_organization_id())
      and exists (
       select 1 from public.profiles p
       where p.user_id=(select auth.uid())
         and p.organization_id=%I.organization_id
         and p.is_active
         and p.role in (''admin'',''editor'')
      )
    )',
   t,t
  );
 end loop;
end $$;
create function planner_private.request_event(r public.requests,p_action text) returns void
language sql security definer set search_path='' as $$
 insert into public.request_events(organization_id,request_id,actor_user_id,actor_name,action,request_snapshot)
 values(r.organization_id,r.id,auth.uid(),coalesce((select full_name from public.profiles where user_id=auth.uid()),''),p_action,to_jsonb(r))
$$;
create function planner_private.validate_request(p_type text,p_start date,p_end date,p_start_time time,p_end_time time,p_note text)
returns void language plpgsql set search_path='' as $$
begin
 if p_type is null or p_type not in ('Ferie','Permesso','Cambio turno','Indisponibilità','Altro')
 or p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end)
 or p_end<p_start or p_end-p_start>365 or p_note is null or length(p_note)>4000
 or (p_start_time is null)<>(p_end_time is null) or p_start_time=p_end_time
 or (p_type='Ferie' and (p_start_time is not null or p_end_time is not null)) then raise exception 'Invalid request'; end if;
end $$;
create function public.request_create(p_organization_id uuid,p_employee_id text,p_type text,
 p_start_date date,p_end_date date,p_start_time time default null,p_end_time time default null,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.profiles; r public.requests; ename text;
begin
 m:=planner_private.lock_member(p_organization_id);
 if m.role='viewer' and (m.employee_id is null or m.employee_id is distinct from p_employee_id) then
  raise exception 'Viewer must use their linked employee' using errcode='42501'; end if;
 perform planner_private.validate_request(p_type,p_start_date,p_end_date,p_start_time,p_end_time,p_note);
 select name into ename from public.employees where organization_id=p_organization_id and id=p_employee_id;
 if not found then raise exception 'Employee not found'; end if;
 insert into public.requests(organization_id,employee_id,employee_name,created_by_user_id,created_by_name,
 type,start_date,end_date,start_time,end_time,note)
 values(p_organization_id,p_employee_id,ename,m.user_id,m.full_name,p_type,p_start_date,p_end_date,p_start_time,p_end_time,p_note)
 returning * into r;
 perform planner_private.request_event(r,'created');
 return to_jsonb(r);
end $$;
create function public.request_update(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_type text,p_start_date date,p_end_date date,p_start_time time default null,p_end_time time default null,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.profiles; r public.requests;
begin
 m:=planner_private.lock_member(p_organization_id);
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Request not found'; end if;
 if m.role='viewer' and (r.created_by_user_id is distinct from m.user_id or r.employee_id is distinct from m.employee_id) then
  raise exception 'Only your own linked request may be edited' using errcode='42501'; end if;
 if r.status<>'pending' then raise exception 'Only pending requests may be edited'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 perform planner_private.validate_request(p_type,p_start_date,p_end_date,p_start_time,p_end_time,p_note);
 update public.requests set type=p_type,start_date=p_start_date,end_date=p_end_date,start_time=p_start_time,
 end_time=p_end_time,note=p_note,version=version+1,updated_at=now() where id=r.id returning * into r;
 perform planner_private.request_event(r,'edited');
 return to_jsonb(r);
end $$;

-- Preview is advisory; approve validates BOTH tokens under the same lock.
create function public.request_approval_preview(p_organization_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; conflicts jsonb; overlap_ids jsonb;
begin
 perform planner_private.lock_member(p_organization_id,'writer');
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id;
 if not found or r.status<>'pending' then raise exception 'Pending request not found'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('shift',to_jsonb(s),'variation',to_jsonb(v)) order by s.date),'[]'::jsonb)
 into conflicts from public.shifts s left join public.attendance_variations v on v.organization_id=s.organization_id and v.shift_id=s.id
 where s.organization_id=p_organization_id and s.employee_id=r.employee_id and s.date between r.start_date and r.end_date and r.type='Ferie';
 select coalesce(jsonb_agg(q.id),'[]'::jsonb) into overlap_ids from public.requests q
 where q.organization_id=p_organization_id and q.employee_id=r.employee_id and q.id<>r.id
 and q.type='Ferie' and q.status='approved' and q.start_date<=r.end_date and q.end_date>=r.start_date and r.type='Ferie';
 return jsonb_build_object('request',to_jsonb(r),'expected_version',r.version,
 'expected_revision',(select revision from public.planner_state where organization_id=p_organization_id and id=true),
 'conflicts',conflicts,'blocking_request_ids',overlap_ids,'requires_confirmation',jsonb_array_length(conflicts)>0);
end $$;
create function public.request_approve(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint,p_confirm_replace boolean default false,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; d date; sid text; prev jsonb; variation jsonb; applied jsonb;
begin
 perform planner_private.lock_member(p_organization_id,'writer');
 perform planner_private.check_revision(p_organization_id,p_expected_revision);
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Request not found'; end if;
 if r.status<>'pending' then raise exception 'Only pending requests may be approved'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if p_note is null or length(p_note)>4000 or p_confirm_replace is null then raise exception 'Invalid approval'; end if;
 if r.type='Ferie' then
  if exists(select 1 from public.requests q where q.organization_id=p_organization_id and q.employee_id=r.employee_id
    and q.id<>r.id and q.type='Ferie' and q.status='approved' and q.start_date<=r.end_date and q.end_date>=r.start_date) then
   raise exception 'Overlapping approved Ferie must be cancelled first';
  end if;
  if not p_confirm_replace and exists(select 1 from public.shifts where organization_id=p_organization_id
    and employee_id=r.employee_id and date between r.start_date and r.end_date) then
   return jsonb_build_object('ok',false,'code','confirmation_required','preview',public.request_approval_preview(p_organization_id,p_request_id));
  end if;
  for d in select r.start_date+n from generate_series(0,r.end_date-r.start_date) n loop
   sid:=r.employee_id||'|'||d::text;
   select to_jsonb(s) into prev from public.shifts s where organization_id=p_organization_id and id=sid;
   select to_jsonb(v) into variation from public.attendance_variations v where organization_id=p_organization_id and shift_id=sid;
   delete from public.attendance_variations where organization_id=p_organization_id and shift_id=sid;
   insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,preset_id,preset_name,preset_color,source_request_id)
   values(p_organization_id,sid,r.employee_id,d,'Ferie',null,null,null,null,null,r.id)
   on conflict(organization_id,id) do update set type='Ferie',start_time=null,end_time=null,
    preset_id=null,preset_name=null,preset_color=null,source_request_id=excluded.source_request_id,updated_at=now();
   -- A cancelled older request may have left a marker. Set this new marker only
   -- after the replacement is complete; ordinary planner saves cannot set it.
   update public.shifts set source_request_id=r.id where organization_id=p_organization_id and id=sid;
   select to_jsonb(s) into applied from public.shifts s where organization_id=p_organization_id and id=sid;
   insert into public.request_shift_changes(organization_id,request_id,employee_id,shift_date,previous_shift,previous_variation,applied_shift)
   values(p_organization_id,r.id,r.employee_id,d,prev,variation,applied);
  end loop;
  perform planner_private.bump_revision(p_organization_id);
 end if;
 update public.requests set status='approved',decided_by_user_id=auth.uid(),decided_at=now(),decision_note=p_note,
 version=version+1,updated_at=now() where id=r.id returning * into r;
 perform planner_private.request_event(r,'approved');
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',
  (select revision from public.planner_state where organization_id=p_organization_id and id=true));
end $$;
create function public.request_reject(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests;
begin
 perform planner_private.lock_member(p_organization_id,'writer');
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found or r.status<>'pending' then raise exception 'Pending request not found'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if p_note is null or length(p_note)>4000 then raise exception 'Invalid note'; end if;
 update public.requests set status='rejected',decided_by_user_id=auth.uid(),decided_at=now(),decision_note=p_note,
 version=version+1,updated_at=now() where id=r.id returning * into r;
 perform planner_private.request_event(r,'rejected');
 return to_jsonb(r);
end $$;

-- Restoring an old preset must not create a snapshot that planner_save would
-- immediately reject because its current organization preset has changed.
create function planner_private.restore_preset_compatible(p_oid uuid,p_shift jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare settings_value jsonb; preset jsonb; shift_type text:=p_shift->>'type';
begin
 if p_shift is null then return true; end if;
 select value into settings_value from public.settings where organization_id=p_oid and id=true;
 if shift_type in ('Mattina','Pomeriggio') then
  return coalesce(to_char((p_shift->>'start_time')::time,'HH24:MI')=settings_value->'presets'->shift_type->>'start'
   and to_char((p_shift->>'end_time')::time,'HH24:MI')=settings_value->'presets'->shift_type->>'end',false);
 end if;
 if p_shift->>'preset_id' is not null then
  select value into preset from jsonb_array_elements(coalesce(settings_value->'presets'->'custom','[]'::jsonb))
  where value->>'id'=p_shift->>'preset_id';
  if preset is null then return true; end if; -- deleted presets remain archived on shifts, as in v1.1
  return coalesce(p_shift->>'preset_name'=preset->>'name'
   and upper(p_shift->>'preset_color')=upper(preset->>'color')
   and to_char((p_shift->>'start_time')::time,'HH24:MI')=preset->>'start'
   and to_char((p_shift->>'end_time')::time,'HH24:MI')=preset->>'end',false);
 end if;
 return true;
end $$;

-- A strict all-or-nothing restoration. No partial restoration and no force
-- overwrite. Use p_restore=false explicitly to cancel while keeping current rows.
create function public.request_cancel(p_organization_id uuid,p_request_id uuid,p_expected_version bigint,
 p_expected_revision bigint default null,p_restore boolean default null,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; r public.requests; b public.request_shift_changes; conflicts jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select * into r from public.requests where id=p_request_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Request not found'; end if;
 if p_expected_version is null or r.version<>p_expected_version then raise exception 'Request version conflict' using errcode='40001'; end if;
 if r.status not in ('pending','approved') then raise exception 'Only pending or approved requests may be cancelled'; end if;
 if m.role='viewer' and (r.status<>'pending' or r.created_by_user_id is distinct from m.user_id) then
  raise exception 'Viewer may only cancel their own pending request' using errcode='42501'; end if;
 if p_note is null or length(p_note)>4000 then raise exception 'Invalid note'; end if;
 if r.status='approved' and r.type='Ferie' then
  perform planner_private.check_revision(p_organization_id,p_expected_revision);
  if p_restore is null then raise exception 'Choose restore previous shifts or keep current shifts'; end if;
  if p_restore then
   select coalesce(jsonb_agg(bc.shift_date order by bc.shift_date),'[]'::jsonb) into conflicts
   from public.request_shift_changes bc left join public.shifts s
    on s.organization_id=bc.organization_id and s.id=bc.employee_id||'|'||bc.shift_date::text
   where bc.organization_id=p_organization_id and bc.request_id=r.id and
    (s.source_request_id is distinct from r.id
     or not planner_private.restore_preset_compatible(p_organization_id,bc.previous_shift)
     or (to_jsonb(s)-array['created_at','updated_at']) is distinct from (bc.applied_shift-array['created_at','updated_at'])
     or exists(select 1 from public.attendance_variations v where v.organization_id=p_organization_id and v.shift_id=s.id));
   if (select count(*) from public.request_shift_changes where organization_id=p_organization_id and request_id=r.id)<>r.end_date-r.start_date+1 then
    raise exception 'Incomplete restoration backup'; end if;
   if jsonb_array_length(conflicts)>0 then
    return jsonb_build_object('ok',false,'code','restoration_conflict','dates',conflicts,'request',to_jsonb(r));
   end if;
   for b in select * from public.request_shift_changes where organization_id=p_organization_id and request_id=r.id order by shift_date loop
    delete from public.shifts where organization_id=p_organization_id and id=b.employee_id||'|'||b.shift_date::text;
    if b.previous_shift is not null then
     -- Restore original preset fields/timestamps, but never revive older ownership.
     insert into public.shifts select (jsonb_populate_record(null::public.shifts,b.previous_shift||jsonb_build_object('source_request_id',null))).*;
    end if;
    if b.previous_variation is not null then
     insert into public.attendance_variations select (jsonb_populate_record(null::public.attendance_variations,b.previous_variation)).*;
    end if;
   end loop;
   update public.request_shift_changes set restored_at=now() where organization_id=p_organization_id and request_id=r.id;
  else
   update public.shifts set source_request_id=null where organization_id=p_organization_id and source_request_id=r.id;
  end if;
  perform planner_private.bump_revision(p_organization_id);
 end if;
 update public.requests set status='cancelled',cancelled_by_user_id=auth.uid(),cancelled_at=now(),cancellation_note=p_note,
 restoration=case when r.status='approved' and r.type='Ferie' then case when p_restore then 'restored' else 'kept' end else null end,
 version=version+1,updated_at=now() where id=r.id returning * into r;
 perform planner_private.request_event(r,'cancelled');
 return jsonb_build_object('ok',true,'request',to_jsonb(r),'revision',
  (select revision from public.planner_state where organization_id=p_organization_id and id=true));
end $$;

-- Unified snapshot save; preserves v1.1 API, validation, custom fields and CAS.
create or replace function public.planner_save(payload jsonb,expected_revision bigint,only_empty boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); current_revision bigint; k text; v jsonb; preset jsonb;
begin
 if auth.uid() is null or oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform planner_private.lock_member(oid,'writer');
 -- Browser context is only a precondition, never an authority: prevents stale
 -- requests writing into a new membership if an administrator moves a user.
 if payload->>'expected_organization_id' is distinct from oid::text then raise exception 'Organization changed' using errcode='42501'; end if;
 -- The browser never chooses the target organization. Reject explicit spoofing.
 if payload ? 'organization_id' or payload ? 'organizationId' then raise exception 'Organization is server-derived' using errcode='42501'; end if;
 select revision into current_revision from public.planner_state where organization_id=oid and id=true for update;
 if expected_revision is null or current_revision is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if only_empty is null then raise exception 'Invalid import mode'; end if;
 if only_empty and (exists(select 1 from public.employees where organization_id=oid) or exists(select 1 from public.settings where organization_id=oid) or exists(select 1 from public.notes where organization_id=oid)) then raise exception 'Organization not empty' using errcode='40001'; end if;
 if payload->'data'->>'version' is distinct from '1' or not public.planner_valid_settings(payload->'settings')
 or jsonb_typeof(payload->'data'->'employees') is distinct from 'array' or jsonb_typeof(payload->'notes') is distinct from 'array'
 or jsonb_typeof(payload->'data'->'shifts') is distinct from 'object' or jsonb_typeof(payload->'variations') is distinct from 'object' then raise exception 'Invalid payload'; end if;

 -- Strict v1.1 custom validation, including missing/null fields (SQL CHECK
 -- expressions alone accept UNKNOWN and are insufficient for JSON validation).
 if jsonb_typeof(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) is distinct from 'array' then raise exception 'Invalid custom presets'; end if;
 for preset in select value from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) loop
  if jsonb_typeof(preset) is distinct from 'object' or nullif(trim(preset->>'id'),'') is null
  or coalesce(length(trim(preset->>'name')),0) not between 1 and 100
  or coalesce(preset->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or coalesce(preset->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or preset->>'start'=preset->>'end' or coalesce(preset->>'color','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid custom preset'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p group by lower(trim(p->>'name')) having count(*)>1)
 or exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p group by p->>'id' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p where lower(trim(p->>'name')) in ('mattina','pomeriggio','centrale','riposo','malattia','ferie')) then raise exception 'Duplicate custom preset'; end if;

 for k,v in select key,value from jsonb_each(payload->'data'->'shifts') loop
  if jsonb_typeof(v) is distinct from 'object' or nullif(trim(v->>'type'),'') is null then raise exception 'Invalid shift'; end if;
  if v ? 'source_request_id' or v ? 'sourceRequestId' or v ? 'organization_id' then raise exception 'Server-managed shift field'; end if;
  if v->>'type' in ('Riposo','Malattia','Ferie') then
   if v->>'start' is not null or v->>'end' is not null then raise exception 'Off-day times must be null'; end if;
  elsif coalesce(v->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(v->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'start'=v->>'end' then raise exception 'Invalid shift time'; end if;
  if v ? 'presetId' then
   if v->>'type' in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie')
   or nullif(trim(v->>'presetId'),'') is null or coalesce(length(trim(v->>'presetName')),0) not between 1 and 100
   or v->>'type' is distinct from v->>'presetName' or coalesce(v->>'presetColor','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid custom shift'; end if;
   select p into preset from jsonb_array_elements(coalesce(payload->'settings'->'presets'->'custom','[]'::jsonb)) p where p->>'id'=v->>'presetId';
   if preset is not null and (v->>'presetName' is distinct from preset->>'name' or v->>'start' is distinct from preset->>'start'
    or v->>'end' is distinct from preset->>'end' or upper(v->>'presetColor') is distinct from upper(preset->>'color')) then raise exception 'Custom preset mismatch'; end if;
  elsif v ? 'presetName' or v ? 'presetColor' or v->>'type' not in ('Mattina','Pomeriggio','Centrale','Riposo','Malattia','Ferie') then raise exception 'Unknown shift type or incomplete preset'; end if;

 if v->>'type' in ('Mattina','Pomeriggio') and (v->>'start' is distinct from payload->'settings'->'presets'->(v->>'type')->>'start' or v->>'end' is distinct from payload->'settings'->'presets'->(v->>'type')->>'end') then raise exception 'Preset mismatch'; end if;
 if not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=left(k,length(k)-11)) then raise exception 'Orphan shift'; end if;
 if v->>'type' in ('Mattina','Pomeriggio','Centrale') and (v->>'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v->>'start'=v->>'end') then raise exception 'Invalid shift time'; end if;
 end loop;
 for k,v in select key,value from jsonb_each(payload->'variations') loop
 if k is distinct from (v->>'employeeId')||'|'||(v->>'date') or not (payload->'data'->'shifts' ? k) then raise exception 'Orphan variation'; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(payload->'notes') n where coalesce(n->>'employeeId','')<>'' and not exists(select 1 from jsonb_array_elements(payload->'data'->'employees') e where e->>'id'=n->>'employeeId')) then raise exception 'Orphan note'; end if;
 insert into public.employees(organization_id,id,name,position)
 select oid,e->>'id',e->>'name',ord from jsonb_array_elements(payload->'data'->'employees') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set name=excluded.name,position=excluded.position,updated_at=now();
 delete from public.attendance_variations where organization_id=oid and id not in(select key from jsonb_each(payload->'variations'));
 delete from public.shifts where organization_id=oid and id not in(select key from jsonb_each(payload->'data'->'shifts'));
 insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,preset_id,preset_name,preset_color)
 select oid,key,left(key,length(key)-11),right(key,10)::date,value->>'type',(value->>'start')::time,(value->>'end')::time,value->>'presetId',value->>'presetName',upper(value->>'presetColor') from jsonb_each(payload->'data'->'shifts')
 on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,end_time=excluded.end_time,preset_id=excluded.preset_id,preset_name=excluded.preset_name,preset_color=excluded.preset_color,updated_at=now();
 insert into public.attendance_variations(organization_id,id,shift_id,actual_start_time,actual_end_time,reason,custom_reason,note)
 select oid,key,key,(value->>'start')::time,(value->>'end')::time,value->>'reason',value->>'customReason',value->>'note' from jsonb_each(payload->'variations')
 on conflict(organization_id,id) do update set actual_start_time=excluded.actual_start_time,actual_end_time=excluded.actual_end_time,reason=excluded.reason,custom_reason=excluded.custom_reason,note=excluded.note,updated_at=now();
 if exists(select 1 from public.attendance_variations v join public.shifts s on s.organization_id=v.organization_id and s.id=v.shift_id where v.organization_id=oid and s.type in ('Riposo','Malattia','Ferie')) then raise exception 'Invalid variation'; end if;
 delete from public.notes where organization_id=oid and id not in(select e->>'id' from jsonb_array_elements(payload->'notes') e);
 insert into public.notes(organization_id,id,text,date,employee_id,position)
 select oid,e->>'id',e->>'text',nullif(e->>'date','')::date,nullif(e->>'employeeId',''),ord from jsonb_array_elements(payload->'notes') with ordinality t(e,ord)
 on conflict(organization_id,id) do update set text=excluded.text,date=excluded.date,employee_id=excluded.employee_id,position=excluded.position,updated_at=now();
 delete from public.employees where organization_id=oid and id not in(select e->>'id' from jsonb_array_elements(payload->'data'->'employees') e);
 insert into public.settings(organization_id,id,value) values(oid,true,payload->'settings') on conflict(organization_id,id) do update set value=excluded.value,updated_at=now();
 update public.planner_state set revision=revision+1 where organization_id=oid and id=true;
 return public.planner_load();
end $$;

-- Keep the v1.1 serializer behind a locked, active-member entry point.
alter function public.planner_load() rename to planner_load_v4;
revoke all on function public.planner_load_v4() from public,anon,authenticated;
create function public.planner_load() returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 oid uuid:=public.current_organization_id();
 member_role text;
 result jsonb;
begin
 if oid is null then raise exception 'Access denied' using errcode='42501'; end if;

 perform 1 from public.planner_state where organization_id=oid and id=true for share;
 if not found then raise exception 'Organization state missing'; end if;

 select role into member_role
 from public.profiles
 where user_id=auth.uid()
   and organization_id=oid
   and is_active;

 if member_role is null then raise exception 'Access denied' using errcode='42501'; end if;

 result:=public.planner_load_v4();

 -- Viewer keeps the complete schedule across all dates, but managerial
 -- notes and attendance-variation details are removed from the RPC payload.
 if member_role='viewer' then
  result:=jsonb_set(result,'{snapshot,notes}','[]'::jsonb,false);
  result:=jsonb_set(result,'{snapshot,variations}','{}'::jsonb,false);
 end if;

 return result;
end $$;
-- Old save bodies must never provide an alternative mutation path.
create or replace function public.planner_save_v3(payload jsonb,expected_revision bigint,only_empty boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
begin raise exception 'Legacy save disabled' using errcode='42501'; end $$;
revoke all on function public.planner_save_v3(jsonb,bigint,boolean),public.planner_load_v3(),
 public.planner_access_allowed(),public.planner_load_internal(),public.planner_save_internal(jsonb,bigint,boolean)
 from public,anon,authenticated;

-- Explicit allowlist. Supabase defaults can grant anon/authenticated directly,
-- so revoking only PUBLIC is not enough. Private helpers never get RPC grants.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='planner_private' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in (
  'current_organization_id','account_context','account_update','organization_onboard',
  'organization_members','organization_member_update','user_preferences_save',
  'organization_invite_create','organization_invite_list','organization_invite_revoke','organization_invite_accept',
  'request_create','request_update','request_approval_preview','request_approve','request_reject','request_cancel',
  'planner_load','planner_save') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;
