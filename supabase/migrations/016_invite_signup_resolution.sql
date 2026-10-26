-- Resolve the invited identity before signup so the browser never asks the
-- recipient to re-enter (or choose) the email bound to a valid invitation.
begin;
create function public.organization_invite_resolve(p_token text) returns jsonb
language sql stable security definer set search_path='' as $$
 select (
  select jsonb_build_object('email',i.email,'expires_at',i.expires_at)
  from public.organization_invitations i
  where coalesce(p_token ~ '^[0-9a-f]{64}$',false)
   and i.token_hash=sha256(convert_to(p_token,'UTF8'))
   and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
 )
$$;
revoke all on function public.organization_invite_resolve(text) from public,anon,authenticated;
grant execute on function public.organization_invite_resolve(text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
