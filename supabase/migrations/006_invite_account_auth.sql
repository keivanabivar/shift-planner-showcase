-- Account identity is email; employee names are managed separately by administrators.
begin;
drop function public.organization_invite_accept(text,text);
create function public.organization_invite_accept(p_token text) returns jsonb
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
 insert into public.profiles(user_id,organization_id,full_name,role,employee_id,is_active)
 values(uid,i.organization_id,'',i.role,i.employee_id,true);
 update public.organization_invitations set accepted_by=uid,accepted_at=now() where id=i.id;
 return public.account_context();
end $$;

revoke all on function public.organization_invite_accept(text) from public,anon,authenticated;
grant execute on function public.organization_invite_accept(text) to authenticated;
-- A high-entropy bearer token plus the entered email can be checked before signup.
-- Return only a boolean: never expose the invitation email, tenant or role.
create function public.organization_invite_check(p_token text,p_email text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(p_token ~ '^[0-9a-f]{64}$',false) and exists (
 select 1 from public.organization_invitations
 where token_hash=sha256(convert_to(p_token,'UTF8')) and email=lower(trim(p_email))
 and accepted_at is null and revoked_at is null and expires_at>now())
$$;
revoke all on function public.organization_invite_check(text,text) from public,anon,authenticated;
grant execute on function public.organization_invite_check(text,text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
