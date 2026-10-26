-- Multi-branch authorization foundation. Apply once after 016.
-- This migration does not enable Cron and does not change archive retention.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

do $$ begin
 if to_regprocedure('public.organization_invite_resolve(text)') is null
 or to_regclass('public.archive_months') is null then
  raise exception '017 requires migrations 001 through 016';
 end if;
 if to_regclass('public.branches') is not null then
  raise exception '017 already applied, or public.branches exists: inspect before proceeding';
 end if;
end $$;

lock table public.organizations,public.profiles,public.planner_state,public.employees,
 public.shifts,public.notes,public.requests,public.organization_invitations in access exclusive mode;

create table public.branches(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete restrict,
 name text not null check(length(trim(name)) between 1 and 200),
 active boolean not null default true,
 control_state text not null default 'setup' check(control_state in ('setup','managed','recovery')),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(organization_id,id)
);
create unique index branches_active_name_unique on public.branches(organization_id,lower(trim(name))) where active;
create index branches_organization on public.branches(organization_id,active);

insert into public.branches(organization_id,name,control_state)
select o.id,'Sede principale',case when exists(
 select 1 from public.profiles p where p.organization_id=o.id and p.is_active and p.role='admin'
) then 'managed' else 'setup' end
from public.organizations o;

alter table public.profiles add column organization_role text not null default 'member'
 check(organization_role in ('owner','member'));
alter table public.profiles add column visibility_level text not null default 'all_branches'
 check(visibility_level in ('own','home_branch','all_branches'));

with ranked as (
 select user_id,organization_id,row_number() over(partition by organization_id order by created_at,user_id) n
 from public.profiles where role='admin' and is_active
)
update public.profiles p set organization_role='owner'
from ranked r where r.user_id=p.user_id and r.n=1;

create table public.branch_memberships(
 organization_id uuid not null,
 branch_id uuid not null,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('branch_admin','editor')),
 is_primary boolean not null default false,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(branch_id,user_id),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict,
 foreign key(user_id) references public.profiles(user_id) on delete cascade
);
create index branch_memberships_user on public.branch_memberships(organization_id,user_id,is_active);
create unique index branch_one_active_primary on public.branch_memberships(branch_id)
 where role='branch_admin' and is_primary and is_active;

insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary,is_active)
select p.organization_id,b.id,p.user_id,
 case when p.role='admin' then 'branch_admin' else 'editor' end,
 p.organization_role='owner' and p.role='admin',p.is_active
from public.profiles p join public.branches b on b.organization_id=p.organization_id
where p.role in ('admin','editor');

create table public.branch_access_events(
 id bigint generated always as identity primary key,
 organization_id uuid not null,
 branch_id uuid not null,
 actor_user_id uuid references auth.users(id) on delete set null,
 subject_user_id uuid references auth.users(id) on delete set null,
 action text not null check(action in (
  'branch_created','branch_renamed','branch_deactivated','branch_admin_invited',
  'branch_admin_accepted','branch_handover_completed','branch_admin_added',
  'branch_admin_removed','branch_editor_added','primary_admin_changed','recovery_started','recovery_ended',
  'cross_branch_proposed','cross_branch_approved','cross_branch_rejected'
 )),
 reason text not null default '' check(length(reason)<=2000),
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict
);
create index branch_access_events_scope on public.branch_access_events(organization_id,branch_id,created_at desc);

alter table public.employees add column home_branch_id uuid;
update public.employees e set home_branch_id=b.id
from public.branches b where b.organization_id=e.organization_id;
alter table public.employees alter column home_branch_id set not null;
alter table public.employees add constraint employees_home_branch_fk
 foreign key(organization_id,home_branch_id) references public.branches(organization_id,id) on delete restrict;
create index employees_home_branch on public.employees(organization_id,home_branch_id);

alter table public.shifts add column branch_id uuid;
update public.shifts s set branch_id=e.home_branch_id from public.employees e
where e.organization_id=s.organization_id and e.id=s.employee_id;
alter table public.shifts alter column branch_id set not null;
alter table public.shifts add constraint shifts_branch_fk
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict;
create index shifts_branch_date on public.shifts(organization_id,branch_id,date);

alter table public.notes add column branch_id uuid;
alter table public.notes add constraint notes_branch_fk
 foreign key(organization_id,branch_id) references public.branches(organization_id,id) on delete restrict;
create index notes_branch_date on public.notes(organization_id,branch_id,date);

alter table public.requests add column approval_branch_id uuid;
update public.requests r set approval_branch_id=e.home_branch_id from public.employees e
where e.organization_id=r.organization_id and e.id=r.employee_id;
alter table public.requests alter column approval_branch_id set not null;
alter table public.requests add constraint requests_approval_branch_fk
 foreign key(organization_id,approval_branch_id) references public.branches(organization_id,id) on delete restrict;
create index requests_approval_branch on public.requests(organization_id,approval_branch_id,status);

alter table public.organization_invitations
 add column target_branch_id uuid,
 add column target_role text,
 add column visibility_level text not null default 'all_branches'
  check(visibility_level in ('own','home_branch','all_branches'));
update public.organization_invitations i set
 target_branch_id=b.id,
 target_role=case i.role when 'admin' then 'branch_admin' when 'editor' then 'editor' else 'viewer' end
from public.branches b where b.organization_id=i.organization_id;
alter table public.organization_invitations alter column target_branch_id set not null;
alter table public.organization_invitations alter column target_role set not null;
alter table public.organization_invitations add constraint invitations_target_role_check
 check(target_role in ('branch_admin','editor','employee','viewer'));
alter table public.organization_invitations add constraint invitations_target_branch_fk
 foreign key(organization_id,target_branch_id) references public.branches(organization_id,id) on delete restrict;
create index invitations_target_branch on public.organization_invitations(organization_id,target_branch_id);

create table public.cross_branch_shift_requests(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 employee_id text not null,
 home_branch_id uuid not null,
 destination_branch_id uuid not null,
 shift_date date not null check(isfinite(shift_date)),
 shift_type text not null,
 start_time time,end_time time,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 proposed_by uuid not null references auth.users(id) on delete restrict,
 proposed_at timestamptz not null default now(),
 decided_by uuid references auth.users(id) on delete restrict,
 decided_at timestamptz,decision_note text not null default '' check(length(decision_note)<=2000),
 foreign key(organization_id,employee_id) references public.employees(organization_id,id) on delete restrict,
 foreign key(organization_id,home_branch_id) references public.branches(organization_id,id) on delete restrict,
 foreign key(organization_id,destination_branch_id) references public.branches(organization_id,id) on delete restrict,
 check(home_branch_id<>destination_branch_id),
 check((status='pending' and decided_by is null and decided_at is null) or
       (status in ('approved','rejected') and decided_by is not null and decided_at is not null)),
 check((shift_type in ('Riposo','Malattia','Ferie') and start_time is null and end_time is null) or
       (shift_type not in ('Riposo','Malattia','Ferie') and start_time is not null and end_time is not null and start_time<>end_time))
);
create unique index cross_branch_one_pending on public.cross_branch_shift_requests(organization_id,employee_id,shift_date)
 where status='pending';
create index cross_branch_destination_status on public.cross_branch_shift_requests(organization_id,destination_branch_id,status);

-- Compatibility defaults for legacy INSERT statements. Ambiguous multi-branch
-- writes fail rather than silently selecting a branch.
create function planner_private.default_branch_for_write(p_oid uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare result uuid;
begin
 select id into result from public.branches where organization_id=p_oid and active order by created_at,id limit 1;
 if result is null or (select count(*) from public.branches where organization_id=p_oid and active)<>1 then
  raise exception 'Branch must be explicit for a multi-branch organization' using errcode='42501';
 end if;
 return result;
end $$;

create function planner_private.fill_employee_home_branch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.home_branch_id is null then new.home_branch_id:=planner_private.default_branch_for_write(new.organization_id); end if;
 return new;
end $$;
create trigger employees_fill_home_branch before insert on public.employees
for each row execute function planner_private.fill_employee_home_branch();

create function planner_private.fill_shift_branch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.branch_id is null then
  select home_branch_id into new.branch_id from public.employees
  where organization_id=new.organization_id and id=new.employee_id;
 end if;
 if new.branch_id is null then raise exception 'Shift branch required'; end if;
 return new;
end $$;
create trigger shifts_fill_branch before insert on public.shifts
for each row execute function planner_private.fill_shift_branch();

create function planner_private.fill_request_branch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.approval_branch_id is null then
  select home_branch_id into new.approval_branch_id from public.employees
  where organization_id=new.organization_id and id=new.employee_id;
 end if;
 if new.approval_branch_id is null then raise exception 'Request approval branch required'; end if;
 return new;
end $$;
create trigger requests_fill_approval_branch before insert on public.requests
for each row execute function planner_private.fill_request_branch();

create function planner_private.is_owner(p_oid uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.user_id=auth.uid()
  and p.organization_id=p_oid and p.is_active and p.organization_role='owner')
$$;
create function planner_private.branch_role(p_oid uuid,p_branch_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select bm.role from public.branch_memberships bm where bm.organization_id=p_oid
  and bm.branch_id=p_branch_id and bm.user_id=auth.uid() and bm.is_active
$$;
create function planner_private.employee_home_branch(p_oid uuid,p_employee_id text) returns uuid
language sql stable security definer set search_path='' as $$
 select e.home_branch_id from public.employees e where e.organization_id=p_oid and e.id=p_employee_id
$$;
create function planner_private.shares_branch_membership(p_oid uuid,p_branch_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.branch_memberships bm where bm.organization_id=p_oid
  and bm.branch_id=p_branch_id and bm.user_id=auth.uid() and bm.is_active)
$$;
create function planner_private.shift_branch(p_oid uuid,p_shift_id text) returns uuid
language sql stable security definer set search_path='' as $$
 select s.branch_id from public.shifts s where s.organization_id=p_oid and s.id=p_shift_id
$$;
create function planner_private.request_branch(p_oid uuid,p_request_id uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select r.approval_branch_id from public.requests r where r.organization_id=p_oid and r.id=p_request_id
$$;
create function planner_private.can_operate_branch(p_oid uuid,p_branch_id uuid,p_admin_only boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.branches b where b.organization_id=p_oid and b.id=p_branch_id and b.active and (
  exists(select 1 from public.branch_memberships bm where bm.organization_id=p_oid and bm.branch_id=b.id
   and bm.user_id=auth.uid() and bm.is_active and (not p_admin_only or bm.role='branch_admin'))
  or (b.control_state in ('setup','recovery') and planner_private.is_owner(p_oid))
 ))
$$;
create function planner_private.can_operate_all_branches(p_oid uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.branches where organization_id=p_oid and active)
 and not exists(select 1 from public.branches b where b.organization_id=p_oid and b.active
  and not planner_private.can_operate_branch(p_oid,b.id,false))
$$;
create function planner_private.lock_branch_operator(p_oid uuid,p_branch_id uuid,p_admin_only boolean default false)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 if public.current_organization_id() is distinct from p_oid then raise exception 'Access denied' using errcode='42501'; end if;
 perform 1 from public.planner_state where organization_id=p_oid and id=true for update;
 select * into m from public.profiles where user_id=auth.uid() and organization_id=p_oid and is_active;
 if not found or not planner_private.can_operate_branch(p_oid,p_branch_id,p_admin_only) then
  raise exception 'Branch access denied' using errcode='42501';
 end if;
 return m;
end $$;

-- Preserve legacy single-branch behavior while preventing whole-organization
-- RPCs from becoming a cross-branch mutation or schedule-disclosure path.
create or replace function planner_private.lock_member(p_organization_id uuid,p_access text default 'member')
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
 or p_access not in ('member','writer','admin')
 or (p_access='admin' and m.organization_role<>'owner')
 or (p_access='writer' and (m.role not in ('admin','editor')
   or not planner_private.can_operate_all_branches(p_organization_id))) then
  raise exception 'Access denied' using errcode='42501';
 end if;
 return m;
end $$;

create or replace function public.account_context() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',p.user_id,'organization_id',p.organization_id,
  'organization_name',o.name,'full_name',p.full_name,'role',p.role,
  'organization_role',p.organization_role,'visibility_level',p.visibility_level,
  'employee_id',p.employee_id,'is_active',p.is_active,
  'branches',coalesce((select jsonb_agg(jsonb_build_object('branch_id',bm.branch_id,
   'role',bm.role,'is_primary',bm.is_primary,'is_active',bm.is_active) order by bm.created_at)
   from public.branch_memberships bm where bm.user_id=p.user_id),'[]'::jsonb))
 from public.profiles p join public.organizations o on o.id=p.organization_id
 where p.user_id=auth.uid() and p.is_active
$$;

create or replace function public.account_update(manager_name text,organization_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; current_name text;
begin
 m:=planner_private.lock_member(public.current_organization_id());
 if manager_name is null or length(trim(manager_name)) not between 1 and 200
 or organization_name is null or length(trim(organization_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 select name into current_name from public.organizations where id=m.organization_id;
 if trim(organization_name) is distinct from current_name and m.organization_role<>'owner' then
  raise exception 'Only the Organization Owner may rename the organization' using errcode='42501';
 end if;
 update public.profiles set full_name=trim(manager_name),updated_at=now() where user_id=m.user_id;
 if trim(organization_name) is distinct from current_name then
  update public.organizations set name=trim(organization_name),updated_at=now() where id=m.organization_id;
 end if;
 return public.account_context();
end $$;

create or replace function public.organization_onboard(organization_name text,manager_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); oid uuid; bid uuid;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 perform 1 from auth.users where id=uid and email_confirmed_at is not null for update;
 if not found then raise exception 'Confirmed email required' using errcode='42501'; end if;
 if exists(select 1 from public.profiles where user_id=uid) then return public.account_context(); end if;
 if organization_name is null or length(trim(organization_name)) not between 1 and 200
 or manager_name is null or length(trim(manager_name)) not between 1 and 200 then raise exception 'Invalid name'; end if;
 insert into public.organizations(name) values(trim(organization_name)) returning id into oid;
 insert into public.planner_state(organization_id,id) values(oid,true);
 insert into public.profiles(user_id,organization_id,full_name,role,organization_role,visibility_level)
 values(uid,oid,trim(manager_name),'admin','owner','all_branches');
 insert into public.branches(organization_id,name,control_state,created_by)
 values(oid,'Sede principale','managed',uid) returning id into bid;
 insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary)
 values(oid,bid,uid,'branch_admin',true);
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action)
 values(oid,bid,uid,uid,'branch_created'),(oid,bid,uid,uid,'branch_admin_added');
 return public.account_context();
end $$;

create function public.branch_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; result jsonb;
begin
 m:=planner_private.lock_member(p_organization_id);
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.id,'organization_id',b.organization_id,'name',b.name,'active',b.active,
  'control_state',b.control_state,'admins',coalesce((select jsonb_agg(jsonb_build_object(
   'user_id',p.user_id,'full_name',p.full_name,'is_primary',bm.is_primary,'is_active',bm.is_active)
   order by bm.is_primary desc,p.full_name) from public.branch_memberships bm join public.profiles p on p.user_id=bm.user_id
   where bm.branch_id=b.id and bm.role='branch_admin'),'[]'::jsonb)
 ) order by b.created_at),'[]'::jsonb) into result from public.branches b where b.organization_id=p_organization_id
 and (m.organization_role='owner' or exists(select 1 from public.branch_memberships x
  where x.branch_id=b.id and x.user_id=m.user_id and x.is_active));
 return result;
end $$;

create function public.branch_create(p_organization_id uuid,p_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_name is null or length(trim(p_name)) not between 1 and 200 then raise exception 'Invalid branch name'; end if;
 insert into public.branches(organization_id,name,created_by) values(p_organization_id,trim(p_name),auth.uid()) returning * into b;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
 values(p_organization_id,b.id,auth.uid(),'branch_created',jsonb_build_object('name',b.name));
 return to_jsonb(b);
end $$;

create function public.branch_update(p_organization_id uuid,p_branch_id uuid,p_name text,p_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches; old_name text; old_active boolean;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id for update;
 if not found or p_name is null or length(trim(p_name)) not between 1 and 200 or p_active is null then raise exception 'Invalid branch'; end if;
 old_name:=b.name;old_active:=b.active;
 if old_active and not p_active and (exists(select 1 from public.shifts where organization_id=p_organization_id and branch_id=p_branch_id and date>=current_date)
  or exists(select 1 from public.branch_memberships where branch_id=p_branch_id and is_active)
  or exists(select 1 from public.organization_invitations where target_branch_id=p_branch_id and accepted_at is null and revoked_at is null and expires_at>now()))
 then raise exception 'Branch still has active operations'; end if;
 update public.branches set name=trim(p_name),active=p_active,updated_at=now() where id=p_branch_id returning * into b;
 if old_name is distinct from b.name then insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
  values(p_organization_id,p_branch_id,auth.uid(),'branch_renamed',jsonb_build_object('from',old_name,'to',b.name)); end if;
 if old_active and not b.active then insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action)
  values(p_organization_id,p_branch_id,auth.uid(),'branch_deactivated'); end if;
 return to_jsonb(b);
end $$;

create function public.branch_recovery_start(p_organization_id uuid,p_branch_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'Recovery reason required'; end if;
 select * into b from public.branches where organization_id=p_organization_id and id=p_branch_id and active for update;
 if not found then raise exception 'Branch not found'; end if;
 update public.branches set control_state='recovery',updated_at=now() where id=p_branch_id returning * into b;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason)
 values(p_organization_id,p_branch_id,auth.uid(),'recovery_started',trim(p_reason));
 return to_jsonb(b);
end $$;

create function public.branch_recovery_end(p_organization_id uuid,p_branch_id uuid,p_reason text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.branches;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 perform 1 from public.branches where organization_id=p_organization_id and id=p_branch_id and active for update;
 if not found or not exists(select 1 from public.branch_memberships where branch_id=p_branch_id and role='branch_admin' and is_active)
 then raise exception 'Active Branch Admin required'; end if;
 update public.branches set control_state='managed',updated_at=now() where id=p_branch_id returning * into b;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason)
 values(p_organization_id,p_branch_id,auth.uid(),'recovery_ended',coalesce(trim(p_reason),''));
 return to_jsonb(b);
end $$;

create function public.branch_admin_remove(p_organization_id uuid,p_branch_id uuid,p_user_id uuid,p_reason text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare remaining integer; state text;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 update public.branch_memberships set is_active=false,is_primary=false,updated_at=now()
 where organization_id=p_organization_id and branch_id=p_branch_id and user_id=p_user_id and role='branch_admin' and is_active;
 if not found then raise exception 'Active Branch Admin not found'; end if;
 select count(*) into remaining from public.branch_memberships where branch_id=p_branch_id and role='branch_admin' and is_active;
 if remaining=0 then update public.branches set control_state='recovery',updated_at=now() where id=p_branch_id returning control_state into state;
 else
  state:=(select control_state from public.branches where id=p_branch_id);
  if not exists(select 1 from public.branch_memberships where branch_id=p_branch_id and role='branch_admin' and is_active and is_primary) then
   update public.branch_memberships set is_primary=true,updated_at=now() where branch_id=p_branch_id and user_id=(
    select user_id from public.branch_memberships where branch_id=p_branch_id and role='branch_admin' and is_active order by created_at,user_id limit 1
   );
   insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action,details)
   select p_organization_id,p_branch_id,auth.uid(),user_id,'primary_admin_changed',jsonb_build_object('automatic',true)
   from public.branch_memberships where branch_id=p_branch_id and role='branch_admin' and is_active and is_primary;
  end if;
 end if;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action,reason,details)
 values(p_organization_id,p_branch_id,auth.uid(),p_user_id,'branch_admin_removed',coalesce(trim(p_reason),''),jsonb_build_object('remaining_admins',remaining));
 return jsonb_build_object('organization_id',p_organization_id,'branch_id',p_branch_id,'remaining_admins',remaining,'control_state',state);
end $$;

create function public.branch_primary_admin_set(p_organization_id uuid,p_branch_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 perform 1 from public.branch_memberships where organization_id=p_organization_id and branch_id=p_branch_id
  and user_id=p_user_id and role='branch_admin' and is_active for update;
 if not found then raise exception 'Active Branch Admin not found'; end if;
 update public.branch_memberships set is_primary=false,updated_at=now() where branch_id=p_branch_id and is_primary;
 update public.branch_memberships set is_primary=true,updated_at=now() where branch_id=p_branch_id and user_id=p_user_id;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action)
 values(p_organization_id,p_branch_id,auth.uid(),p_user_id,'primary_admin_changed');
 return jsonb_build_object('organization_id',p_organization_id,'branch_id',p_branch_id,'user_id',p_user_id,'is_primary',true);
end $$;

-- Compatibility for the current Access UI. Role/state changes are mapped to
-- the sole active branch; once an organization has multiple branches the
-- generic organization-wide mutation fails closed in favor of branch RPCs.
create or replace function public.organization_member_update(p_organization_id uuid,p_user_id uuid,
 p_role text,p_employee_id text,p_is_active boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target public.profiles; bid uuid; branch_count integer; mapped_role text; was_admin boolean;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 if p_role is null or p_role not in ('admin','editor','viewer') or p_is_active is null then raise exception 'Invalid membership'; end if;
 select * into target from public.profiles where user_id=p_user_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Member not found'; end if;
 if target.organization_role='owner' and (p_role<>'admin' or not p_is_active) then
  raise exception 'Organization Owner cannot be disabled or demoted here' using errcode='42501';
 end if;
 if p_employee_id is not null and not exists(select 1 from public.employees where organization_id=p_organization_id and id=p_employee_id)
 then raise exception 'Employee not found'; end if;
 select count(*),min(id::text)::uuid into branch_count,bid from public.branches where organization_id=p_organization_id and active;
 if branch_count<>1 and (p_role is distinct from target.role or p_is_active is distinct from target.is_active) then
  raise exception 'Use branch-scoped access management' using errcode='42501';
 end if;
 was_admin:=branch_count=1 and exists(select 1 from public.branch_memberships where branch_id=bid and user_id=p_user_id and role='branch_admin' and is_active);
 update public.profiles set role=p_role,employee_id=p_employee_id,is_active=p_is_active,updated_at=now()
 where user_id=p_user_id returning * into target;
 if branch_count=1 and target.organization_role<>'owner' then
  if p_role in ('admin','editor') then
   mapped_role:=case when p_role='admin' then 'branch_admin' else 'editor' end;
   insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary,is_active)
   values(p_organization_id,bid,p_user_id,mapped_role,false,p_is_active)
   on conflict(branch_id,user_id) do update set role=excluded.role,is_active=excluded.is_active,
    is_primary=false,updated_at=now();
  else
   update public.branch_memberships set is_active=false,is_primary=false,updated_at=now()
   where branch_id=bid and user_id=p_user_id;
  end if;
  if was_admin and not exists(select 1 from public.branch_memberships where branch_id=bid and user_id=p_user_id and role='branch_admin' and is_active) then
   insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action,details)
   values(p_organization_id,bid,auth.uid(),p_user_id,'branch_admin_removed',jsonb_build_object('source','legacy member update'));
   if not exists(select 1 from public.branch_memberships where branch_id=bid and role='branch_admin' and is_active) then
    update public.branches set control_state='recovery',updated_at=now() where id=bid;
   end if;
  end if;
 end if;
 return to_jsonb(target);
end $$;

create function public.branch_invite_create(p_organization_id uuid,p_email text,p_target_branch_id uuid,
 p_target_role text,p_employee_id text,p_visibility_level text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare token text; iid uuid; normalized text:=lower(trim(p_email)); legacy_role text; branch_name text;
begin
 if normalized is null or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized)>320
 or p_target_role not in ('branch_admin','editor','employee','viewer')
 or p_visibility_level not in ('own','home_branch','all_branches') then raise exception 'Invalid invitation'; end if;
 if p_target_role='branch_admin' then
  if planner_private.is_owner(p_organization_id) then perform planner_private.lock_member(p_organization_id,'admin');
  else perform planner_private.lock_branch_operator(p_organization_id,p_target_branch_id,true); end if;
 else perform planner_private.lock_branch_operator(p_organization_id,p_target_branch_id,p_target_role in ('editor','employee','viewer')); end if;
 select name into branch_name from public.branches where organization_id=p_organization_id and id=p_target_branch_id and active;
 if branch_name is null then raise exception 'Target branch not found'; end if;
 if p_employee_id is not null and not exists(select 1 from public.employees where organization_id=p_organization_id
  and id=p_employee_id and home_branch_id=p_target_branch_id) then raise exception 'Employee does not belong to target branch'; end if;
 if p_target_role='employee' and p_employee_id is null then raise exception 'Employee invitation requires linked employee'; end if;
 if p_employee_id is not null and exists(select 1 from public.profiles where organization_id=p_organization_id and employee_id=p_employee_id)
 then raise exception 'Employee already linked'; end if;
 update public.organization_invitations set revoked_at=now() where organization_id=p_organization_id
  and email=normalized and accepted_at is null and revoked_at is null;
 token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 legacy_role:=case when p_target_role='viewer' or p_target_role='employee' then 'viewer' else 'editor' end;
 insert into public.organization_invitations(organization_id,email,role,employee_id,token_hash,created_by,expires_at,
  target_branch_id,target_role,visibility_level)
 values(p_organization_id,normalized,legacy_role,p_employee_id,sha256(convert_to(token,'UTF8')),auth.uid(),now()+interval '7 days',
  p_target_branch_id,p_target_role,p_visibility_level) returning id into iid;
 if p_target_role='branch_admin' then insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
  values(p_organization_id,p_target_branch_id,auth.uid(),'branch_admin_invited',jsonb_build_object('invitation_id',iid,'email',normalized)); end if;
 return jsonb_build_object('id',iid,'token',token,'expires_at',now()+interval '7 days',
  'organization_id',p_organization_id,'target_branch_id',p_target_branch_id,'target_role',p_target_role);
end $$;

create or replace function public.organization_invite_create(p_organization_id uuid,p_email text,
 p_role text default 'viewer',p_employee_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare bid uuid; mapped text;
begin
 perform planner_private.lock_member(p_organization_id,'admin');
 bid:=planner_private.default_branch_for_write(p_organization_id);
 mapped:=case p_role when 'admin' then 'branch_admin' when 'editor' then 'editor' else 'viewer' end;
 return public.branch_invite_create(p_organization_id,p_email,bid,mapped,p_employee_id,'all_branches');
end $$;

create or replace function public.organization_invite_accept(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.organization_invitations; uid uuid:=auth.uid(); user_email text; first_admin boolean;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation' using errcode='42501'; end if;
 select lower(email) into user_email from auth.users where id=uid and email_confirmed_at is not null for update;
 if user_email is null then raise exception 'Confirmed email required' using errcode='42501'; end if;
 if exists(select 1 from public.profiles where user_id=uid) then raise exception 'Account already has a membership; contact an admin (no automatic tenant transfer)'; end if;
 select * into i from public.organization_invitations where token_hash=sha256(convert_to(p_token,'UTF8'));
 if not found then raise exception 'Invalid invitation' using errcode='42501'; end if;
 perform 1 from public.planner_state where organization_id=i.organization_id and id=true for update;
 select * into i from public.organization_invitations where id=i.id for update;
 if i.email is distinct from user_email or i.accepted_at is not null or i.revoked_at is not null or i.expires_at<=clock_timestamp()
 then raise exception 'Invalid or expired invitation' using errcode='42501'; end if;
 if i.employee_id is not null and not exists(select 1 from public.employees where organization_id=i.organization_id
  and id=i.employee_id and home_branch_id=i.target_branch_id) then raise exception 'Invitation branch no longer matches employee'; end if;
 insert into public.profiles(user_id,organization_id,full_name,role,employee_id,is_active,organization_role,visibility_level)
 values(uid,i.organization_id,'',i.role,i.employee_id,true,'member',i.visibility_level);
 if i.target_role in ('branch_admin','editor') then
  first_admin:=i.target_role='branch_admin' and not exists(select 1 from public.branch_memberships
   where branch_id=i.target_branch_id and role='branch_admin' and is_active);
  insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary)
  values(i.organization_id,i.target_branch_id,uid,i.target_role,first_admin);
  insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action,details)
  values(i.organization_id,i.target_branch_id,uid,uid,
   case when i.target_role='branch_admin' then 'branch_admin_accepted' else 'branch_editor_added' end,
   jsonb_build_object('role',i.target_role,'invitation_id',i.id));
  if first_admin then
   update public.branches set control_state='managed',updated_at=now() where id=i.target_branch_id;
   insert into public.branch_access_events(organization_id,branch_id,actor_user_id,subject_user_id,action)
   values(i.organization_id,i.target_branch_id,uid,uid,'branch_handover_completed');
  end if;
 end if;
 update public.organization_invitations set accepted_by=uid,accepted_at=now() where id=i.id;
 return public.account_context();
end $$;

create function public.branch_invite_list(p_organization_id uuid,p_branch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,true);
 return coalesce((select jsonb_agg(to_jsonb(i)-'token_hash' order by i.created_at desc)
  from public.organization_invitations i where i.organization_id=p_organization_id
   and i.target_branch_id=p_branch_id),'[]'::jsonb);
end $$;

create function public.branch_invite_revoke(p_organization_id uuid,p_branch_id uuid,p_invitation_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,true);
 update public.organization_invitations set revoked_at=coalesce(revoked_at,now())
 where organization_id=p_organization_id and target_branch_id=p_branch_id and id=p_invitation_id
  and accepted_at is null and revoked_at is null;
 if not found then raise exception 'Pending branch invitation not found'; end if;
end $$;

create function public.branch_employee_create(p_organization_id uuid,p_branch_id uuid,p_employee_id text,p_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.employees; next_position integer;
begin
 perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,false);
 if nullif(trim(p_employee_id),'') is null or p_name is null or length(trim(p_name)) not between 1 and 100 then raise exception 'Invalid employee'; end if;
 select coalesce(max(position),0)+1 into next_position from public.employees where organization_id=p_organization_id;
 insert into public.employees(organization_id,id,name,position,home_branch_id)
 values(p_organization_id,trim(p_employee_id),trim(p_name),next_position,p_branch_id) returning * into e;
 perform planner_private.bump_revision(p_organization_id);
 return to_jsonb(e);
end $$;

create function public.branch_shift_upsert(p_organization_id uuid,p_branch_id uuid,p_employee_id text,p_date date,
 p_type text,p_start time default null,p_end time default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.shifts; home uuid; sid text;
begin
 perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,false);
 select home_branch_id into home from public.employees where organization_id=p_organization_id and id=p_employee_id;
 if home is null then raise exception 'Employee not found'; end if;
 if home<>p_branch_id then raise exception 'Cross-branch approval required' using errcode='42501'; end if;
 sid:=p_employee_id||'|'||p_date::text;
 if exists(select 1 from public.shifts where organization_id=p_organization_id and id=sid and branch_id<>p_branch_id)
 then raise exception 'Shift belongs to another branch' using errcode='42501'; end if;
 insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id)
 values(p_organization_id,sid,p_employee_id,p_date,p_type,p_start,p_end,p_branch_id)
 on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,
  end_time=excluded.end_time,branch_id=excluded.branch_id,preset_id=null,preset_name=null,preset_color=null,updated_at=now()
 returning * into s;
 perform planner_private.bump_revision(p_organization_id);
 return to_jsonb(s);
end $$;

create function public.cross_branch_shift_propose(p_organization_id uuid,p_employee_id text,p_destination_branch_id uuid,
 p_date date,p_type text,p_start time default null,p_end time default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare home uuid; r public.cross_branch_shift_requests;
begin
 select home_branch_id into home from public.employees where organization_id=p_organization_id and id=p_employee_id;
 if home is null or home=p_destination_branch_id then raise exception 'Invalid cross-branch assignment'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,home,true);
 perform 1 from public.branches where organization_id=p_organization_id and id=p_destination_branch_id and active;
 if not found then raise exception 'Destination branch not found'; end if;
 if exists(select 1 from public.shifts where organization_id=p_organization_id and employee_id=p_employee_id and date=p_date)
 then raise exception 'Employee already has a shift on this date'; end if;
 insert into public.cross_branch_shift_requests(organization_id,employee_id,home_branch_id,destination_branch_id,
  shift_date,shift_type,start_time,end_time,proposed_by)
 values(p_organization_id,p_employee_id,home,p_destination_branch_id,p_date,p_type,p_start,p_end,auth.uid()) returning * into r;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,details)
 values(p_organization_id,p_destination_branch_id,auth.uid(),'cross_branch_proposed',jsonb_build_object('request_id',r.id,'employee_id',p_employee_id,'home_branch_id',home,'date',p_date));
 return to_jsonb(r);
end $$;

create function public.cross_branch_shift_decide(p_organization_id uuid,p_request_id uuid,p_approve boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.cross_branch_shift_requests; s public.shifts; sid text;
begin
 if p_approve is null or p_note is null or length(p_note)>2000 then raise exception 'Invalid decision'; end if;
 select * into r from public.cross_branch_shift_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found or r.status<>'pending' then raise exception 'Pending cross-branch request not found'; end if;
 perform planner_private.lock_branch_operator(p_organization_id,r.destination_branch_id,true);
 update public.cross_branch_shift_requests set status=case when p_approve then 'approved' else 'rejected' end,
  decided_by=auth.uid(),decided_at=now(),decision_note=p_note where id=r.id returning * into r;
 if p_approve then
  sid:=r.employee_id||'|'||r.shift_date::text;
  if exists(select 1 from public.shifts where organization_id=p_organization_id and id=sid)
  then raise exception 'Employee already has a shift on this date'; end if;
  insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time,branch_id)
  values(r.organization_id,sid,r.employee_id,r.shift_date,r.shift_type,r.start_time,r.end_time,r.destination_branch_id)
  on conflict(organization_id,id) do update set type=excluded.type,start_time=excluded.start_time,
   end_time=excluded.end_time,branch_id=excluded.branch_id,preset_id=null,preset_name=null,preset_color=null,updated_at=now()
  returning * into s;
  perform planner_private.bump_revision(p_organization_id);
 end if;
 insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason,details)
 values(p_organization_id,r.destination_branch_id,auth.uid(),case when p_approve then 'cross_branch_approved' else 'cross_branch_rejected' end,
  p_note,jsonb_build_object('request_id',r.id,'employee_id',r.employee_id,'date',r.shift_date));
 return jsonb_build_object('request',to_jsonb(r),'shift',case when s.id is null then null else to_jsonb(s) end);
end $$;

create function public.branch_note_upsert(p_organization_id uuid,p_branch_id uuid,p_id text,p_text text,p_date date,p_employee_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n public.notes; next_position integer;
begin
 if p_text is null or length(trim(p_text)) not between 1 and 4000 then raise exception 'Invalid note'; end if;
 if p_branch_id is null then
  perform planner_private.lock_member(p_organization_id,'admin');
 else
  perform planner_private.lock_branch_operator(p_organization_id,p_branch_id,true);
 end if;
 if exists(select 1 from public.notes where organization_id=p_organization_id and id=p_id
  and branch_id is distinct from p_branch_id) then raise exception 'Note belongs to another scope' using errcode='42501'; end if;
 if p_employee_id is not null and p_branch_id is not null and planner_private.employee_home_branch(p_organization_id,p_employee_id) is distinct from p_branch_id
 then raise exception 'Employee does not belong to note branch'; end if;
 select coalesce(max(position),0)+1 into next_position from public.notes where organization_id=p_organization_id;
 insert into public.notes(organization_id,id,text,date,employee_id,position,updated_by_user_id,branch_id)
 values(p_organization_id,p_id,trim(p_text),p_date,p_employee_id,next_position,auth.uid(),p_branch_id)
 on conflict(organization_id,id) do update set text=excluded.text,date=excluded.date,employee_id=excluded.employee_id,
  updated_by_user_id=auth.uid(),branch_id=excluded.branch_id,updated_at=now() returning * into n;
 perform planner_private.bump_revision(p_organization_id);
 return to_jsonb(n);
end $$;

-- Branch-aware RLS for direct reads. Security-definer RPCs still re-check scope.
alter table public.branches enable row level security;
alter table public.branch_memberships enable row level security;
alter table public.branch_access_events enable row level security;
alter table public.cross_branch_shift_requests enable row level security;
revoke all on public.branches,public.branch_memberships,public.branch_access_events,
 public.cross_branch_shift_requests from public,anon,authenticated;
grant select on public.branches,public.branch_memberships,public.branch_access_events,
 public.cross_branch_shift_requests to authenticated;
create policy branch_tenant_read on public.branches for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(select 1 from public.profiles p
  where p.user_id=(select auth.uid()) and p.organization_id=branches.organization_id and p.is_active));
create policy branch_membership_read on public.branch_memberships for select to authenticated using(
 organization_id=(select public.current_organization_id()) and (planner_private.is_owner(organization_id)
  or user_id=(select auth.uid()) or planner_private.shares_branch_membership(organization_id,branch_id)));
create policy branch_events_owner_read on public.branch_access_events for select to authenticated using(
 organization_id=(select public.current_organization_id()) and planner_private.is_owner(organization_id));
create policy cross_branch_participant_read on public.cross_branch_shift_requests for select to authenticated using(
 organization_id=(select public.current_organization_id()) and (proposed_by=(select auth.uid())
  or planner_private.can_operate_branch(organization_id,home_branch_id,true)
  or planner_private.can_operate_branch(organization_id,destination_branch_id,true)));

drop policy if exists active_tenant_read on public.employees;
create policy branch_employee_read on public.employees for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(select 1 from public.profiles p
 where p.user_id=(select auth.uid()) and p.organization_id=employees.organization_id and p.is_active and (
  planner_private.can_operate_branch(employees.organization_id,employees.home_branch_id,false)
  or p.employee_id=employees.id or p.visibility_level='all_branches'
  or (p.visibility_level='home_branch' and employees.home_branch_id=planner_private.employee_home_branch(p.organization_id,p.employee_id))
 )));
drop policy if exists active_tenant_read on public.shifts;
create policy branch_shift_read on public.shifts for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(select 1 from public.profiles p
 where p.user_id=(select auth.uid()) and p.organization_id=shifts.organization_id and p.is_active and (
  planner_private.can_operate_branch(shifts.organization_id,shifts.branch_id,false)
  or p.employee_id=shifts.employee_id or p.visibility_level='all_branches'
  or (p.visibility_level='home_branch' and shifts.branch_id=planner_private.employee_home_branch(p.organization_id,p.employee_id))
 )));
drop policy if exists active_tenant_read on public.notes;
drop policy if exists writer_tenant_read on public.notes;
create policy branch_note_read on public.notes for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(select 1 from public.profiles p
 where p.user_id=(select auth.uid()) and p.organization_id=notes.organization_id and p.is_active and (
  notes.branch_id is null
  or (notes.branch_id is not null and planner_private.can_operate_branch(notes.organization_id,notes.branch_id,false))
  or (p.role='viewer' and (p.visibility_level='all_branches' or notes.employee_id=p.employee_id
   or (p.visibility_level='home_branch' and notes.branch_id=planner_private.employee_home_branch(p.organization_id,p.employee_id))))
 )));
drop policy if exists member_request_read on public.requests;
create policy branch_request_read on public.requests for select to authenticated using(
 organization_id=(select public.current_organization_id()) and exists(select 1 from public.profiles p
 where p.user_id=(select auth.uid()) and p.organization_id=requests.organization_id and p.is_active and (
  planner_private.can_operate_branch(requests.organization_id,requests.approval_branch_id,false)
  or requests.employee_id=p.employee_id
  or (p.role='viewer' and requests.status='pending' and (
   p.visibility_level='all_branches' or (p.visibility_level='home_branch'
    and requests.approval_branch_id=planner_private.employee_home_branch(p.organization_id,p.employee_id))
  ))
 )));
drop policy if exists writer_tenant_read on public.attendance_variations;
create policy branch_variation_read on public.attendance_variations for select to authenticated using(
 organization_id=(select public.current_organization_id())
 and planner_private.can_operate_branch(organization_id,planner_private.shift_branch(organization_id,shift_id),false));
drop policy if exists writer_tenant_read on public.request_shift_changes;
create policy branch_request_change_read on public.request_shift_changes for select to authenticated using(
 organization_id=(select public.current_organization_id())
 and planner_private.can_operate_branch(organization_id,planner_private.request_branch(organization_id,request_id),false));
drop policy if exists writer_tenant_read on public.request_events;
create policy branch_request_event_read on public.request_events for select to authenticated using(
 organization_id=(select public.current_organization_id())
 and planner_private.can_operate_branch(organization_id,planner_private.request_branch(organization_id,request_id),false));

-- Legacy whole-snapshot load is safe only for viewers with all-branch visibility
-- or operational users who can operate every active branch. Phase 2 replaces it.
create or replace function public.planner_load() returns jsonb
language plpgsql security definer set search_path='' as $$
declare oid uuid:=public.current_organization_id(); m public.profiles; result jsonb;
begin
 if oid is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform 1 from public.planner_state where organization_id=oid and id=true for share;
 select * into m from public.profiles where user_id=auth.uid() and organization_id=oid and is_active;
 if not found then raise exception 'Access denied' using errcode='42501'; end if;
 if m.role='viewer' then
  if m.visibility_level<>'all_branches' then raise exception 'Branch-scoped planner API required' using errcode='42501'; end if;
 elsif not planner_private.can_operate_all_branches(oid) then
  raise exception 'Branch-scoped planner API required' using errcode='42501';
 end if;
 result:=public.planner_load_v4();
 if m.role='viewer' then result:=jsonb_set(result,'{snapshot,variations}','{}'::jsonb,false); end if;
 return result;
end $$;

-- Existing request creation captures home-branch ownership through the trigger.
-- Existing manager approval RPCs use lock_member('writer') and therefore fail
-- closed once the caller cannot operate every active branch.
create or replace function public.request_list(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles;
begin
 m:=planner_private.lock_member(p_organization_id);
 return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from public.requests r
  where r.organization_id=p_organization_id and (
 planner_private.can_operate_branch(p_organization_id,r.approval_branch_id,false)
   or r.employee_id=m.employee_id
   or (m.role='viewer' and r.status='pending' and (
    m.visibility_level='all_branches' or (m.visibility_level='home_branch' and r.approval_branch_id=(
     select e.home_branch_id from public.employees e where e.organization_id=m.organization_id and e.id=m.employee_id
    ))
   ))
  )),'[]'::jsonb);
end $$;

create or replace function public.note_unread_state(p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.profiles; last_read timestamptz;
begin
 m:=planner_private.lock_member(p_organization_id);
 select read_at into last_read from public.note_reads where organization_id=p_organization_id and user_id=m.user_id;
 return jsonb_build_object('organization_id',p_organization_id,'unread',exists(
  select 1 from public.notes n where n.organization_id=p_organization_id
   and n.updated_by_user_id is not null and n.updated_by_user_id<>m.user_id
   and n.updated_at>coalesce(last_read,'-infinity'::timestamptz)
   and (n.branch_id is null
    or (n.branch_id is not null and planner_private.can_operate_branch(p_organization_id,n.branch_id,false))
    or (m.role='viewer' and (m.visibility_level='all_branches' or n.employee_id=m.employee_id
     or (m.visibility_level='home_branch' and n.branch_id=planner_private.employee_home_branch(m.organization_id,m.employee_id))))
   )));
end $$;

-- Explicit allowlist; private helpers remain unreachable through the Data API.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='planner_private' loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); end loop;
end $$;
-- RLS evaluates these side-effect-free predicates as the authenticated role.
-- The private schema itself has no USAGE grant, so clients cannot address them.
grant execute on function planner_private.is_owner(uuid),
 planner_private.can_operate_branch(uuid,uuid,boolean),
 planner_private.employee_home_branch(uuid,text),
 planner_private.shares_branch_membership(uuid,uuid),
 planner_private.shift_branch(uuid,text),planner_private.request_branch(uuid,uuid) to authenticated;
revoke all on function public.branch_list(uuid),public.branch_create(uuid,text),public.branch_update(uuid,uuid,text,boolean),
 public.branch_recovery_start(uuid,uuid,text),public.branch_recovery_end(uuid,uuid,text),
 public.branch_admin_remove(uuid,uuid,uuid,text),public.branch_primary_admin_set(uuid,uuid,uuid),
 public.branch_invite_create(uuid,text,uuid,text,text,text),public.branch_invite_list(uuid,uuid),
 public.branch_invite_revoke(uuid,uuid,uuid),public.branch_employee_create(uuid,uuid,text,text),
 public.branch_shift_upsert(uuid,uuid,text,date,text,time,time),
 public.cross_branch_shift_propose(uuid,text,uuid,date,text,time,time),
 public.cross_branch_shift_decide(uuid,uuid,boolean,text),public.branch_note_upsert(uuid,uuid,text,text,date,text)
 from public,anon,authenticated;
grant execute on function public.branch_list(uuid),public.branch_create(uuid,text),public.branch_update(uuid,uuid,text,boolean),
 public.branch_recovery_start(uuid,uuid,text),public.branch_recovery_end(uuid,uuid,text),
 public.branch_admin_remove(uuid,uuid,uuid,text),public.branch_primary_admin_set(uuid,uuid,uuid),
 public.branch_invite_create(uuid,text,uuid,text,text,text),public.branch_invite_list(uuid,uuid),
 public.branch_invite_revoke(uuid,uuid,uuid),public.branch_employee_create(uuid,uuid,text,text),
 public.branch_shift_upsert(uuid,uuid,text,date,text,time,time),
 public.cross_branch_shift_propose(uuid,text,uuid,date,text,time,time),
 public.cross_branch_shift_decide(uuid,uuid,boolean,text),public.branch_note_upsert(uuid,uuid,text,text,date,text)
 to authenticated;

notify pgrst,'reload schema';
commit;
