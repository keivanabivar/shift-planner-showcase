export const CLIENT_PROTOCOL='planner-030-v1';
export const CLIENT_HEADERS={'x-planner-protocol':CLIENT_PROTOCOL};
export const UPDATE_MESSAGE='Modifiche bloccate. Ricarica la pagina. Se il problema persiste, attendi il completamento dell’aggiornamento. I dati restano consultabili.';
// Keep this explicit read allowlist aligned with migration 030. Unknown RPCs
// require a successful compatibility probe; availability never implies safety.
export const READ_RPCS=new Set(['account_context','current_organization_id','organization_members',
 'organization_invite_check','organization_invite_resolve','organization_invite_list','access_invite_list',
 'branch_list','branch_invite_list','branch_access_overview','employee_branch_assignment_overview',
 'cross_branch_shift_list','planner_load','planner_load_scoped','planner_load_scoped_020',
 'user_planner_preferences','request_list','request_approval_preview','note_unread_state',
 'request_unread_state','archive_list','planner_client_compatibility']);
export function compatibleForWrite(value){return value?.schema_version===30&&value.client_protocol===CLIENT_PROTOCOL&&value.writes_enabled===true;}
export const compatibilityError=()=>Object.assign(Error(UPDATE_MESSAGE),{code:'CLIENT_UPDATE_REQUIRED',userFacing:true});

// Add the marker only to the Data API. Supabase Auth has a separate CORS header
// allowlist; login/recovery must not depend on a new planner-specific header.
export function withClientProtocol(request=fetch){
 return (input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));
  if(!url.pathname.startsWith('/rest/v1/'))return request(input,init);
  const headers=new Headers(init.headers||(typeof input==='object'?input.headers:undefined));
  headers.set('x-planner-protocol',CLIENT_PROTOCOL);
  return request(input,{...init,headers});
 };
}

// Used by the account/onboarding RPCs as well as the Planner repository. Auth
// login, logout and password recovery continue independently of planner writes.
export function gateClientRpc(client){
 const original=client.rpc.bind(client);
 client.rpc=async(name,...args)=>{
  if(!READ_RPCS.has(name)){
   try{const probe=await original('planner_client_compatibility');if(probe.error||!compatibleForWrite(probe.data))return {data:null,error:compatibilityError()};}
   catch{return {data:null,error:compatibilityError()};}
  }
  const result=await original(name,...args);
  if(result.error?.code==='P0030')return {...result,error:compatibilityError()};
  return result;
 };
 return client;
}
