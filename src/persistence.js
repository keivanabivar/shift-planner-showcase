import {STORAGE_KEY,validData,parseDate,shiftType,applyPresetSettings,isAbsence} from './schedule.js';
import {DEFAULT_SETTINGS,NOTES_KEY,SETTINGS_KEY,validNote,validSettings} from './preferences.js';
import {VARIATIONS_KEY,validVariation} from './attendance.js';
import {branchOperations} from './branchPersistence.js';
import {CLIENT_HEADERS,READ_RPCS,compatibleForWrite,compatibilityError} from './clientCompatibility.js';
export const CACHE_KEY='turni.supabase.cache.v1';
export function validateSnapshot(s){
 try{
 if(!s||!validData(s.data)||!validSettings(s.settings)||!Array.isArray(s.notes)||!s.notes.every(validNote)||!s.variations||typeof s.variations!=='object'||Array.isArray(s.variations))return false;
 const ids=new Set(s.data.employees.map(e=>e.id));
 if(s.data.employees.some(e=>!e.id||!e.name.trim())||new Set(s.notes.map(n=>n.id)).size!==s.notes.length)return false;
 if(Object.keys(s.data.shifts).some(k=>{const p=k.lastIndexOf('|');return !ids.has(k.slice(0,p))||!parseDate(k.slice(p+1));}))return false;
 if(s.notes.some(n=>!n.id||(n.date&&!parseDate(n.date))||(n.employeeId&&!ids.has(n.employeeId))))return false;
 return Object.entries(s.variations).every(([k,v])=>validVariation(v)&&k===`${v.employeeId}|${v.date}`&&s.data.shifts[k]&&!isAbsence(shiftType(s.data.shifts[k])));
 }catch{return false;}
}
export function canonical(s){
 const settings={...s.settings};if(settings.statusStyles&&Object.keys(settings.statusStyles).length===0)delete settings.statusStyles;
 const shifts=Object.fromEntries(Object.entries(s.data.shifts).map(([k,v])=>{const type=shiftType(v),scope=v.branchId?{branchId:v.branchId}:{};return [k,isAbsence(type)?{type,off:true,...scope}:{type,off:false,start:v.start,end:v.end,...(v.presetId?{presetId:v.presetId,presetName:v.presetName,presetColor:v.presetColor}:{}),...scope}];}));
 return {data:({version:1,employees:s.data.employees.map(e=>({id:e.id,name:e.name,...(e.homeBranchId?{homeBranchId:e.homeBranchId}:{}),...(Array.isArray(e.branchIds)?{branchIds:e.branchIds}:{})})),shifts}),notes:s.notes.map(n=>({id:n.id,text:n.text,date:n.date,employeeId:n.employeeId,...(n.branchId?{branchId:n.branchId}:{})})),settings:{...settings,presets:{...s.settings.presets,...(Array.isArray(s.settings.presets?.custom)?{custom:[...s.settings.presets.custom].sort((a,b)=>a.id.localeCompare(b.id))}:{})}},variations:Object.fromEntries(Object.entries(s.variations).map(([k,v])=>{
  // The scoped RPC derives a variation's branch from its shift. Creation/editing
  // rebuilds the variation without branchId; compare the same effective scope.
  // Preserve an explicit branch so a genuinely different response still fails.
  const branchId=v.branchId||s.data.shifts[k]?.branchId;
  return [k,{...v,...(branchId?{branchId}:{})}];
 }))};
}
export function readLocal(storage){
 const raw=storage.getItem(STORAGE_KEY),notes=storage.getItem(NOTES_KEY),settings=storage.getItem(SETTINGS_KEY),variations=storage.getItem(VARIATIONS_KEY);
 const s={data:raw?JSON.parse(raw):{version:1,employees:[],shifts:{}},notes:notes?JSON.parse(notes):[],settings:settings?JSON.parse(settings):structuredClone(DEFAULT_SETTINGS),variations:variations?JSON.parse(variations):{}};
 // Removed employees historically left optional note links behind: retain the note text.
 s.notes=s.notes.map(n=>({...n,employeeId:s.data.employees.some(e=>e.id===n.employeeId)?n.employeeId:''}));
 if(!validateSnapshot(s))throw Error('Dati locali non validi. Esporta e conserva la copia prima di continuare.');
 return {snapshot:canonical(s),exists:!!(s.data.employees.length||Object.keys(s.data.shifts).length||s.notes.length||Object.keys(s.variations).length||settings)};
}
export function backupText(snapshot){return JSON.stringify({format:'turni.backup',version:1,exportedAt:new Date().toISOString(),...snapshot},null,2);}
export function parseBackup(text){const value=JSON.parse(text);if(value.format!=='turni.backup'||value.version!==1||!validateSnapshot(value))throw Error('Backup non valido o incompatibile.');return canonical(value);}
export function downloadBackup(snapshot){const url=URL.createObjectURL(new Blob([backupText(snapshot)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=`turni-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function createRepository(url,key,request=fetch,authContext=null){
 if(!url||!key)return null;
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(endpoint.hostname))throw Error('L’URL Supabase deve usare HTTPS.');
 if(key.startsWith('sb_secret_'))throw Error('Usa soltanto la chiave pubblica Supabase.');
 try{if(key.split('.').length===3&&JSON.parse(atob(key.split('.')[1])).role==='service_role')throw Error('private');}catch(e){if(e.message==='private')throw Error('Usa soltanto la chiave pubblica Supabase.');}

 const failure=(message,code='')=>Object.assign(Error(message),{userFacing:true,code});

 async function session(){
  try{return await authContext.getSession();}
  catch{throw failure('Sessione non disponibile. Accedi di nuovo.','SESSION_CHANGED');}
 }

 async function rpc(name,args={},validateResult=null){
  if(!authContext?.organizationId||!authContext?.userId)
   throw failure('Accedi alla tua organizzazione per continuare.','SESSION_CHANGED');

  const current=await session();

  if(!current?.access_token||current.user?.id!==authContext.userId)
   throw failure('Sessione cambiata. Accedi di nuovo.','SESSION_CHANGED');

  if(!READ_RPCS.has(name)){
   let probe;
   try{probe=await rpc('planner_client_compatibility',{},value=>!!value);}
   catch(error){if(error.code==='SESSION_CHANGED')throw error;throw compatibilityError();}
   if(!compatibleForWrite(probe))throw compatibilityError();
  }

  let response;

  try{
   response=await request(`${url.replace(/\/$/,'')}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
     ...CLIENT_HEADERS,
     apikey:key,
     'Content-Type':'application/json',
     Authorization:`Bearer ${current.access_token}`
    },
    body:JSON.stringify(args),
    signal:AbortSignal.timeout(20000)
   });
  }catch{
   throw failure('Connessione non disponibile. Riprova prima di modificare i dati.');
  }

  if(!response.ok){
   const err=await response.json().catch(()=>({}));
   if(err.code==='P0030')throw compatibilityError();

   const message=
    err.code==='40001'
     ?'I dati sono cambiati su un altro dispositivo. Riconnetti e riprova.'
    :err.code==='PGRST202'
     ?'Configurazione del database incompleta. Esegui gli script di migrazione Supabase.'
    :[401,403].includes(response.status)||err.code==='42501'
     ?'Accesso non disponibile. Accedi di nuovo alla tua organizzazione.'
    :'Impossibile completare l’operazione nel database.';

   throw failure(
    message,
    [401,403].includes(response.status)||err.code==='42501'
     ?'SESSION_CHANGED'
     :''
   );
  }

  const raw=await response.text();
  let result=null;

  if(raw){
   try{result=JSON.parse(raw);}
   catch{throw failure('Risposta del database non valida.');}
  }

  if(validateResult){
   if(!validateResult(result,authContext.organizationId))
    throw failure('Risposta del database non valida.');
  }else if(result?.organization_id!==authContext.organizationId){
   throw failure('Organizzazione non corrispondente. Accedi di nuovo.','SESSION_CHANGED');
  }

  if((await session())?.user?.id!==authContext.userId)
   throw failure('Sessione cambiata. Accedi di nuovo.','SESSION_CHANGED');

  return result;
 }

 const org=()=>authContext?.organizationId;

 return {
  requiresCompatibility:true,
  load:(branchIds=null)=>rpc('planner_load_scoped',{p_organization_id:org(),p_branch_ids:branchIds}),

  undo:(token,revisions)=>rpc('planner_undo',{p_organization_id:org(),p_token:token,p_expected_revisions:revisions}),
  saveEmployeeOrder:({branchId,expectedOrder,employeeOrder})=>rpc('user_branch_employee_order_save',{p_organization_id:org(),p_branch_id:branchId,p_expected_order:expectedOrder,p_employee_order:employeeOrder},result=>result?.organization_id===org()&&result.branch_preferences&&typeof result.branch_preferences==='object'),

  bulkDelete:(branchId,shiftIds,revision)=>rpc('planner_bulk_delete_shifts',{
   p_organization_id:org(),p_branch_id:branchId,p_shift_ids:shiftIds,p_expected_revision:revision
  }),

  saveScoped:async(snapshot,previous,branchRevisions,branchIds,options={})=>{
   if(!validateSnapshot(snapshot)||!validateSnapshot(previous))throw failure('Dati non validi. Nessuna modifica salvata.');
   return rpc('planner_apply_branch_operations',{
    p_organization_id:org(),p_operations:branchOperations(canonical(previous),canonical(snapshot),Object.keys(branchRevisions||{})).map(op=>op.kind==='template_upsert'&&options.updateTemplateTimes?.includes(op.id)?{...op,updateFutureTimes:true,timeZone:options.timeZone||'UTC'}:op),
    // Return the complete authorized snapshot after a write. A view-filtered
    // response cannot verify the full snapshot that was submitted.
    p_expected_revisions:branchRevisions||{},p_branch_ids:null
   });
  },

  save:async(snapshot,revision,onlyEmpty=false,branchRevisions={})=>{
   if(!validateSnapshot(snapshot))
    throw failure('Dati non validi. Nessuna modifica salvata.');

   return rpc('planner_save_effective',{
    payload:{
     ...canonical(snapshot),
     expected_organization_id:org(),expected_branch_revisions:branchRevisions
    },
    expected_revision:revision,
    only_empty:onlyEmpty
   });
  },

  members:async()=>(await rpc(
   'branch_access_overview',
   {p_organization_id:org()},
   (result,organizationId)=>
    Array.isArray(result)&&
    result.every(item=>item?.organization_id===organizationId)
  )).map(item=>({...item,role:item.role==='branch_admin'?'admin':item.role==='employee'?'viewer':item.role})),

  updateMember:({userId,role,employeeId,isActive,branchIds=[],visibility='all_branches'})=>rpc(
   'branch_member_assignments_update',
   {
    p_organization_id:org(),
    p_user_id:userId,
    p_role:role==='admin'?'branch_admin':role,
    p_employee_id:employeeId||null,
    p_visibility_level:visibility,
    p_is_active:isActive,
    p_branch_ids:branchIds
   },
   (result,organizationId)=>
    !!result&&result.organization_id===organizationId
  ),

  employeeAssignments:()=>rpc('employee_branch_assignment_overview',{p_organization_id:org()},result=>Array.isArray(result)),
  updateEmployeeAssignments:(employeeId,branchIds)=>rpc('employee_branch_assignment_update',{
   p_organization_id:org(),p_employee_id:employeeId,p_branch_ids:branchIds
  },result=>!!result&&result.organization_id===org()),

  invitations:()=>rpc(
   'access_invite_list',
   {p_organization_id:org()},
   (result,organizationId)=>
    Array.isArray(result)&&
    result.every(item=>item?.organization_id===organizationId)
  ),

  createInvitation:({email,role,employeeId,branchId,visibility='all_branches'})=>rpc(
   branchId?'branch_invite_create':'organization_invite_create',
   branchId?{
    p_organization_id:org(),p_email:email,p_target_branch_id:branchId,p_target_role:role,
    p_employee_id:employeeId||null,p_visibility_level:visibility
   }:{p_organization_id:org(),p_email:email,p_role:role,p_employee_id:employeeId||null},
   result=>
    !!result&&
    typeof result.id==='string'&&
    typeof result.token==='string'&&
    typeof result.expires_at==='string'
  ),

  revokeInvitation:(invitationId)=>rpc(
   'access_invite_revoke',
   {
    p_organization_id:org(),
    p_invitation_id:invitationId
   },
   result=>result===null
  ),

  requests:()=>rpc('request_list',{p_organization_id:org()},(result,organizationId)=>
   Array.isArray(result)&&result.every(item=>item?.organization_id===organizationId)
  ),

  createRequest:value=>rpc('request_create',{
   p_organization_id:org(),p_employee_id:value.employeeId,p_type:value.type,
   p_start_date:value.startDate,p_end_date:value.endDate,
   p_start_time:value.startTime||null,p_end_time:value.endTime||null,p_note:value.note||''
  },(result,organizationId)=>result?.organization_id===organizationId),

  updateRequest:value=>rpc('request_update',{
   p_organization_id:org(),p_request_id:value.id,p_expected_version:value.version,p_type:value.type,
   p_start_date:value.startDate,p_end_date:value.endDate,
   p_start_time:value.startTime||null,p_end_time:value.endTime||null,p_note:value.note||''
  },(result,organizationId)=>result?.organization_id===organizationId),

  requestApprovalPreview:id=>rpc('request_approval_preview',{
   p_organization_id:org(),p_request_id:id
  },(result,organizationId)=>result?.request?.organization_id===organizationId),

  approveRequest:({id,version,revision,confirmReplace=false,note='',type,startDate,endDate,startTime,endTime})=>rpc('request_approve',{
   p_organization_id:org(),p_request_id:id,p_expected_version:version,
   p_expected_revision:revision,p_confirm_replace:confirmReplace,p_note:note,
   p_approved_type:type,p_approved_start_date:startDate,p_approved_end_date:endDate,
   p_approved_start_time:startTime||null,p_approved_end_time:endTime||null
  },(result,organizationId)=>result?.request?.organization_id===organizationId),

  rejectRequest:({id,version,note=''})=>rpc('request_reject',{
   p_organization_id:org(),p_request_id:id,p_expected_version:version,p_note:note
  },(result,organizationId)=>result?.organization_id===organizationId),

  cancelRequest:({id,version,note=''})=>rpc('request_cancel',{
   p_organization_id:org(),p_request_id:id,p_expected_version:version,
   p_expected_revision:null,p_restore:null,p_note:note
  },(result,organizationId)=>result?.request?.organization_id===organizationId),

  revokeRequest:({id,version,revision,restore,note=''})=>rpc('request_revoke',{
   p_organization_id:org(),p_request_id:id,p_expected_version:version,
   p_expected_revision:revision,p_restore:restore,p_note:note
  },(result,organizationId)=>result?.request?.organization_id===organizationId),

  noteUnread:()=>rpc('note_unread_state',{p_organization_id:org()},(result,organizationId)=>result?.organization_id===organizationId),
  markNotesRead:()=>rpc('note_mark_read',{p_organization_id:org()},(result,organizationId)=>result?.organization_id===organizationId),
  requestUnread:()=>rpc('request_unread_state',{p_organization_id:org()},(result,organizationId)=>result?.organization_id===organizationId&&Array.isArray(result.request_ids)),
  markRequestsRead:()=>rpc('request_mark_read',{p_organization_id:org()},(result,organizationId)=>result?.organization_id===organizationId),

  plannerPreferences:()=>rpc('user_planner_preferences',{},(result,organizationId)=>
   result?.organization_id===organizationId&&Array.isArray(result.employee_order)&&
   (result.hidden_employee_ids===undefined||Array.isArray(result.hidden_employee_ids))&&Number.isInteger(result.employee_column_width)
  ),

  savePlannerPreferences:({employeeColumnWidth,employeeOrder})=>rpc('user_planner_preferences_save',{
   p_organization_id:org(),p_employee_column_width:employeeColumnWidth,p_employee_order:employeeOrder
  },(result,organizationId)=>
   result?.organization_id===organizationId&&Array.isArray(result.employee_order)&&Number.isInteger(result.employee_column_width)
  ),

  saveBranchPlannerPreferences:({branchId,employeeOrder,templateSort})=>rpc('user_branch_planner_preferences_save',{
   p_organization_id:org(),p_branch_id:branchId,p_employee_order:employeeOrder??null,
   p_template_sort_key:templateSort?.key??null,p_template_sort_direction:templateSort?.direction??null
  },(result,organizationId)=>result?.organization_id===organizationId&&result.branch_preferences&&typeof result.branch_preferences==='object'),

  savePlannerVisibility:hiddenEmployeeIds=>rpc('user_planner_visibility_save',{
   p_organization_id:org(),p_hidden_employee_ids:hiddenEmployeeIds
  },(result,organizationId)=>
   result?.organization_id===organizationId&&Array.isArray(result.hidden_employee_ids)
  ),

  archive:()=>rpc('archive_list',{p_organization_id:org()},(result,organizationId)=>
   result?.organization_id===organizationId&&Array.isArray(result.months)
  ),

  beginArchiveEdit:(monthStart,confirmation)=>rpc('archive_exceptional_edit_begin',{
   p_organization_id:org(),p_month_start:monthStart,p_confirmation:confirmation
  },result=>result?.organization_id===org()&&result?.month_start===monthStart),

  endArchiveEdit:monthStart=>rpc('archive_exceptional_edit_end',{
   p_organization_id:org(),p_month_start:monthStart
  },result=>result?.organization_id===org()&&result?.month_start===monthStart),

  deleteArchiveMonth:(monthStart,confirmation)=>rpc('archive_delete_manual',{
   p_organization_id:org(),p_month_start:monthStart,p_confirmation:confirmation
  },result=>result?.organization_id===org()&&result?.month_start===monthStart&&['deleted','already_deleted'].includes(result?.status)),

  recordArchiveBackup:(scope,monthStart=null)=>rpc('archive_backup_record',{
   p_organization_id:org(),p_scope:scope,p_month_start:monthStart
  },(result,organizationId)=>result?.organization_id===organizationId&&result?.scope===scope),

  branches:()=>rpc('branch_list',{p_organization_id:org()},(result)=>Array.isArray(result)),
  createBranch:name=>rpc('branch_create',{p_organization_id:org(),p_name:name},result=>!!result?.id),
  updateBranch:({id,name,active})=>rpc('branch_update',{p_organization_id:org(),p_branch_id:id,p_name:name,p_active:active},result=>result?.id===id),
  deleteBranch:({id,confirmation})=>rpc('branch_delete_empty',{p_organization_id:org(),p_branch_id:id,p_confirmation:confirmation},result=>result?.id===id&&result?.deleted===true),
  startBranchRecovery:(id,reason)=>rpc('branch_recovery_start',{p_organization_id:org(),p_branch_id:id,p_reason:reason},result=>result?.id===id),
  endBranchRecovery:(id,reason)=>rpc('branch_recovery_end',{p_organization_id:org(),p_branch_id:id,p_reason:reason},result=>result?.id===id),
  crossBranchRequests:()=>rpc('cross_branch_shift_list',{p_organization_id:org()},result=>Array.isArray(result)),
  proposeCrossBranch:value=>rpc('cross_branch_shift_propose',{p_organization_id:org(),p_employee_id:value.employeeId,p_destination_branch_id:value.branchId,p_date:value.date,p_type:value.type,p_start:value.start||null,p_end:value.end||null,p_preset_id:value.presetId||null,p_preset_name:value.presetName||null,p_preset_color:value.presetColor||null},result=>result?.organization_id===org()),
  decideCrossBranch:(id,approve,note='')=>rpc('cross_branch_shift_decide',{p_organization_id:org(),p_request_id:id,p_approve:approve,p_note:note},result=>result?.request?.organization_id===org())
  };
}
