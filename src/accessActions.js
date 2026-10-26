export const ROLE_LABELS={admin:'Admin',editor:'Editor',viewer:'Viewer'};

export function buildInviteLink(token,location=window.location){
 const target=new URL(location.pathname,location.origin);
 target.searchParams.set('invite',token);
 return target.href;
}

export function memberIdentity(member){
 return member.full_name?.trim()||member.email?.trim()||`utente ${member.user_id}`;
}

export function memberChangeConfirmation(member,patch){
 const identity=memberIdentity(member);
 if(patch.role!==undefined&&patch.role!==member.role){
  return `Confermi il cambio di ruolo per ${identity}?\n${ROLE_LABELS[member.role]||member.role} → ${ROLE_LABELS[patch.role]||patch.role}`;
 }
 if(patch.isActive!==undefined&&patch.isActive!==member.is_active){
  return `Confermi il cambio di accesso per ${identity}?\n${member.is_active?'Attivo':'Disattivato'} → ${patch.isActive?'Attivo':'Disattivato'}`;
 }
 return '';
}
