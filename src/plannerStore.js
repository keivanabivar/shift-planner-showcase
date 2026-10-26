import {STORAGE_KEY} from './schedule.js';
import {NOTES_KEY,SETTINGS_KEY,DEFAULT_SETTINGS} from './preferences.js';
import {VARIATIONS_KEY} from './attendance.js';
import {applyTemplateColorChanges,deletedTemplateColorsAfter,validDeletedTemplateColors} from './templateColors.js';
import {applyBulkDelete,bulkDeleteBranch} from './bulkDelete.js';
import {readLocal,canonical,validateSnapshot,CACHE_KEY} from './persistence.js';
import {compatibleForWrite,UPDATE_MESSAGE} from './clientCompatibility.js';

export const emptySnapshot=()=>({data:{version:1,employees:[],shifts:{}},notes:[],variations:{},settings:structuredClone(DEFAULT_SETTINGS)});
export function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
export const sameSnapshot=(a,b)=>JSON.stringify(stable(canonical(a)))===JSON.stringify(stable(canonical(b)));
export function validateEnvelope(value){if(!value||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.empty!=='boolean')throw Error('Risposta del database non valida.');const s={...value.snapshot,settings:value.snapshot?.settings&&Object.keys(value.snapshot.settings).length?value.snapshot.settings:DEFAULT_SETTINGS};if(!validateSnapshot(s))throw Error('Dati del database non validi.');const selected=Array.isArray(value.selected_branch_ids)?value.selected_branch_ids:[],deleted=Object.hasOwn(value,'deleted_template_colors')?value.deleted_template_colors:[];if(!validDeletedTemplateColors(deleted,s,selected))throw Error('Dati del database non validi.');return {...value,branches:Array.isArray(value.branches)?value.branches:[],selected_branch_ids:selected,branch_revisions:value.branch_revisions&&typeof value.branch_revisions==='object'?value.branch_revisions:{},deleted_template_colors:[...deleted].sort((a,b)=>a.id.localeCompare(b.id)),snapshot:canonical(s)};}
export function createPlannerStore({storage,repository=null,project='',configError='',organizationId='',userId=''}){
 let local,localError='';try{local=readLocal(storage);}catch{local={snapshot:emptySnapshot(),exists:true};localError='Impossibile leggere i dati locali. La copia originale è conservata; nessun dato sarà sovrascritto.';}
 const tenant=!!organizationId;if(tenant&&(!userId||!repository))throw Error('Contesto organizzazione non valido.');const scope=tenant?`${project}:${organizationId}:${userId}`:project;
 const cacheKey=`${CACHE_KEY}:${scope}`,markerKey=`turni.supabase.migrated.v1:${scope}`;
 function envelope(value){if(tenant&&value?.organization_id!==organizationId)throw Object.assign(Error('Organizzazione non corrispondente.'),{code:'SESSION_CHANGED'});return validateEnvelope(value);}
 let migrated=false,cached=null;try{migrated=storage.getItem(markerKey)==='true';cached=JSON.parse(storage.getItem(cacheKey)||'null');if(cached&&!validateSnapshot(cached.snapshot))cached=null;}catch{}
 let state={snapshot:tenant?emptySnapshot():migrated&&cached?canonical(cached.snapshot):local.snapshot,status:configError?'error':repository?'loading':migrated?'offline':localError?'error':'local',message:configError||localError,revision:null,undoDepth:0,branches:[],selectedBranchIds:[],branchRevisions:{},migrated,pending:null,localError};
 let locked=false,disposed=false,deletedTemplateColors=[],features={},history=[];const listeners=new Set();const emit=next=>{if(disposed)return;state={...state,...next};listeners.forEach(fn=>fn());};
 function record(envelope){if(disposed)return;deletedTemplateColors=envelope.deleted_template_colors;features=envelope.planner_features||{};let warning='';try{storage.setItem(cacheKey,JSON.stringify(envelope));storage.setItem(markerKey,'true');}catch{warning='Dati salvati nel database; copia locale non aggiornata. Esporta un backup.';}emit({snapshot:envelope.snapshot,revision:envelope.revision,branches:envelope.branches,selectedBranchIds:envelope.selected_branch_ids,branchRevisions:envelope.branch_revisions,migrated:true,pending:null,status:repository?.requiresCompatibility&&!compatibleForWrite(envelope.client_compatibility)?'readonly':'connected',message:repository?.requiresCompatibility&&!compatibleForWrite(envelope.client_compatibility)?UPDATE_MESSAGE:warning,undoDepth:history.length});}
 async function connect(){if(disposed||locked||!repository)return false;locked=true;history=[];emit({status:'loading',message:'',undoDepth:0});try{const remote=envelope(await repository.load());if(state.migrated||(tenant&&(!local.exists||!remote.empty))){record(remote);}else{emit({status:'migration',pending:remote,revision:remote.revision,message:localError});}return true;}catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:'offline',message:error.userFacing?error.message:'Impossibile connettersi al database. Dati disponibili in sola lettura. Controlla la connessione e la configurazione.'});return false;}finally{locked=false;}}
 async function migrate(choice){if(disposed||locked||!state.pending)return false;locked=true;emit({status:'saving',message:''});try{const latest=envelope(await repository.load());if(choice==='local'){
 if(localError)throw Error(localError);if(!latest.empty){emit({pending:latest});throw Error('Il database contiene già dati. Nessuna importazione eseguita.');}
 const expected=canonical(tenant?local.snapshot:state.snapshot);const result=envelope(await repository.save(expected,latest.organization_revision??latest.revision,true,latest.branch_revisions));const verified=envelope(await repository.load());
 if(result.revision!==verified.revision||!sameSnapshot(expected,verified.snapshot))throw Error('Importazione da verificare. Riconnetti per controllare i dati presenti nel database; la copia locale è conservata.');record(verified);
 }else if(choice==='server'){if(latest.empty&&!tenant)throw Error('Il database è vuoto. Importa i dati locali per inizializzarlo.');record(latest);}else throw Error('Scelta non valida.');return true;
 }catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:'migration',message:error.message});return false;}finally{locked=false;}}
 async function save(next,options={}){if(disposed||locked||!['connected','local'].includes(state.status))return false;if(!validateSnapshot(next)){emit({message:'Dati non validi. Nessuna modifica salvata.'});return false;}
 locked=true;const previousStatus=state.status,previous=state.snapshot;emit({status:'saving',message:''});try{const normalized=canonical(next);if(previousStatus==='connected'){const raw=repository.saveScoped?await repository.saveScoped(normalized,previous,state.branchRevisions,state.selectedBranchIds,options):await repository.save(normalized,state.revision);const result=envelope(raw);if(!sameSnapshot(expectedTemplateChanges(previous,normalized,{...options,today:result.planner_change_date||options.today}),result.snapshot)||JSON.stringify(stable(deletedTemplateColorsAfter(previous,normalized,deletedTemplateColors)))!==JSON.stringify(stable(result.deleted_template_colors)))throw Error('Verifica del salvataggio non riuscita.');if(options.undoable&&result.undo_token&&!sameSnapshot(previous,result.snapshot))pushUndo({kind:'shifts',token:result.undo_token});else if(!options.undoable)history=[];record(result);}else{
 const entries=[[STORAGE_KEY,normalized.data],[NOTES_KEY,normalized.notes],[VARIATIONS_KEY,normalized.variations],[SETTINGS_KEY,normalized.settings]],original=entries.map(([k])=>[k,storage.getItem(k)]);
 try{for(const [k,v] of entries)storage.setItem(k,JSON.stringify(v));}catch(error){for(const [k,v] of original){try{if(v===null)storage.removeItem(k);else storage.setItem(k,v);}catch{}}throw error;}
 if(options.undoable&&!options.skipHistory&&!sameSnapshot(previous,normalized))pushUndo({kind:'local',before:previous,after:normalized});else if(!options.undoable)history=[];emit({snapshot:normalized,status:'local',undoDepth:history.length});
 }return true;}catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:error.code==='CLIENT_UPDATE_REQUIRED'?'readonly':previousStatus==='local'?'local':'error',message:previousStatus==='local'?'Salvataggio locale non riuscito.':error.message||'Errore durante il salvataggio. Riconnetti prima di riprovare.'});return false;}finally{locked=false;}}
 async function bulkDelete(branchId,plan,expectedRevision){
  if(disposed||locked||state.status!=='connected')return false;
  if(!bulkDeleteBranch(state.branches,[branchId])||!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.branchRevisions[branchId]){emit({message:'Sede non disponibile o anteprima non aggiornata. Riconnetti prima di riprovare.'});return false;}
  let expected;try{expected=applyBulkDelete(state.snapshot,plan,branchId);}catch(error){emit({message:error.message});return false;}
  if(!plan.length)return false;
  locked=true;emit({status:'saving',message:''});
  try{
   const result=envelope(await repository.bulkDelete(branchId,plan.map(item=>item.key),expectedRevision));
   if(!sameSnapshot(expected,result.snapshot))throw Error('Verifica dell’eliminazione non riuscita. Riconnetti e controlla i dati.');
   if(result.undo_token)pushUndo({kind:'shifts',token:result.undo_token});record(result);return true;
  }catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:error.code==='CLIENT_UPDATE_REQUIRED'?'readonly':'error',message:error.message});return false;}finally{locked=false;}
 }
 function pushUndo(entry){history.push(entry);if(history.length>50)history.shift();}
 function expectedTemplateChanges(previous,next,options){
  let result=applyTemplateColorChanges(previous,next,deletedTemplateColors,features.template_names===true);
  if(options.updateTemplateTimes?.length){
   const templates=[...(previous.settings.presets?.custom||[]),...deletedTemplateColors];
   const today=options.today||new Date().toLocaleDateString('en-CA');
   result={...result,data:{...result.data,shifts:Object.fromEntries(Object.entries(result.data.shifts).map(([key,shift])=>{
    const scoped=templates.filter(t=>t.branchId===shift.branchId),prior=scoped.find(t=>t.id===shift.presetId)||scoped.find(t=>t.legacyPresetId===shift.presetId);
    const template=next.settings.presets.custom.find(t=>t.id===prior?.id);
    return [key,template&&options.updateTemplateTimes.includes(template.id)&&key.slice(-10)>today&&(prior.start!==template.start||prior.end!==template.end)?{...shift,start:template.start,end:template.end}:shift];
   }))}};
  }
  return result;
 }
 async function saveEmployeeOrder(branchId,expectedOrder,employeeOrder){
  if(disposed||locked||state.status!=='connected')return false;
  locked=true;emit({status:'saving',message:''});
  try{const result=await repository.saveEmployeeOrder({branchId,expectedOrder,employeeOrder});if(disposed)return false;
   if(JSON.stringify(result.branch_preferences?.[branchId]?.employee_order)!==JSON.stringify(employeeOrder))throw Error('Verifica dell’ordine non riuscita.');
   if(JSON.stringify(expectedOrder)!==JSON.stringify(employeeOrder))pushUndo({kind:'order',branchId,before:expectedOrder,after:employeeOrder});
   emit({status:'connected',undoDepth:history.length});return result;
  }catch(error){if(error.code==='SESSION_CHANGED')history=[];emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null,undoDepth:0}:{}),status:error.code==='CLIENT_UPDATE_REQUIRED'?'readonly':'error',message:error.message});return false;}finally{locked=false;}
 }
 async function undo(){
  if(disposed||locked||!history.length||!['connected','local'].includes(state.status))return false;
  const entry=history.at(-1);
  if(entry.kind==='local'){
   if(!sameSnapshot(state.snapshot,entry.after)){emit({message:'Annullamento non disponibile: i dati sono cambiati.'});return false;}
   const saved=await save(entry.before,{undoable:true,skipHistory:true});if(saved){history.pop();emit({undoDepth:history.length});}return saved;
  }
  locked=true;emit({status:'saving',message:''});
  try{
   const result=entry.kind==='order'?await repository.saveEmployeeOrder({branchId:entry.branchId,expectedOrder:entry.after,employeeOrder:entry.before}):envelope(await repository.undo(entry.token,state.branchRevisions));
   if(disposed)return false;history.pop();
   if(entry.kind==='order')emit({status:'connected',undoDepth:history.length});else record(result);
   return entry.kind==='order'?result:true;
  }catch(error){if(error.code==='SESSION_CHANGED')history=[];emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null,undoDepth:0}:{}),status:error.code==='CLIENT_UPDATE_REQUIRED'?'readonly':'error',message:error.message});return false;}finally{locked=false;}
 }
 function offline(){if(repository)emit({status:'offline',message:'Connessione assente — dati locali disponibili in sola lettura'});}
 return {getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},connect,migrate,save,bulkDelete,undo,saveEmployeeOrder,offline,dispose:()=>{disposed=true;history=[];state={...state,snapshot:emptySnapshot(),pending:null,status:'offline'};listeners.clear();},organizationId,userId,localBackup:()=>local.snapshot,hasLocalData:local.exists};
}
