import {STORAGE_KEY} from './schedule.js';
import {NOTES_KEY,SETTINGS_KEY,DEFAULT_SETTINGS} from './preferences.js';
import {VARIATIONS_KEY} from './attendance.js';
import {applyTemplateColorChanges,deletedTemplateColorsAfter,validDeletedTemplateColors} from './templateColors.js';
import {applyBulkDelete,bulkDeleteBranch} from './bulkDelete.js';
import {readLocal,canonical,validateSnapshot,CACHE_KEY} from './persistence.js';

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
 let state={snapshot:tenant?emptySnapshot():migrated&&cached?canonical(cached.snapshot):local.snapshot,status:configError?'error':repository?'loading':migrated?'offline':localError?'error':'local',message:configError||localError,revision:null,branches:[],selectedBranchIds:[],branchRevisions:{},migrated,pending:null,localError};
 let locked=false,disposed=false,deletedTemplateColors=[];const listeners=new Set();const emit=next=>{if(disposed)return;state={...state,...next};listeners.forEach(fn=>fn());};
 function record(envelope){if(disposed)return;deletedTemplateColors=envelope.deleted_template_colors;let warning='';try{storage.setItem(cacheKey,JSON.stringify(envelope));storage.setItem(markerKey,'true');}catch{warning='Dati salvati nel database; copia locale non aggiornata. Esporta un backup.';}emit({snapshot:envelope.snapshot,revision:envelope.revision,branches:envelope.branches,selectedBranchIds:envelope.selected_branch_ids,branchRevisions:envelope.branch_revisions,migrated:true,pending:null,status:'connected',message:warning});}
 async function connect(){if(disposed||locked||!repository)return false;locked=true;emit({status:'loading',message:''});try{const remote=envelope(await repository.load());if(state.migrated||(tenant&&(!local.exists||!remote.empty))){record(remote);}else{emit({status:'migration',pending:remote,revision:remote.revision,message:localError});}return true;}catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:'offline',message:error.userFacing?error.message:'Impossibile connettersi al database. Dati disponibili in sola lettura. Controlla la connessione e la configurazione.'});return false;}finally{locked=false;}}
 async function migrate(choice){if(disposed||locked||!state.pending)return false;locked=true;emit({status:'saving',message:''});try{const latest=envelope(await repository.load());if(choice==='local'){
 if(localError)throw Error(localError);if(!latest.empty){emit({pending:latest});throw Error('Il database contiene già dati. Nessuna importazione eseguita.');}
 const expected=canonical(tenant?local.snapshot:state.snapshot);const result=envelope(await repository.save(expected,latest.organization_revision??latest.revision,true,latest.branch_revisions));const verified=envelope(await repository.load());
 if(result.revision!==verified.revision||!sameSnapshot(expected,verified.snapshot))throw Error('Importazione da verificare. Riconnetti per controllare i dati presenti nel database; la copia locale è conservata.');record(verified);
 }else if(choice==='server'){if(latest.empty&&!tenant)throw Error('Il database è vuoto. Importa i dati locali per inizializzarlo.');record(latest);}else throw Error('Scelta non valida.');return true;
 }catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:'migration',message:error.message});return false;}finally{locked=false;}}
 async function save(next){if(disposed||locked||!['connected','local'].includes(state.status))return false;if(!validateSnapshot(next)){emit({message:'Dati non validi. Nessuna modifica salvata.'});return false;}
 locked=true;const previousStatus=state.status,previous=state.snapshot;emit({status:'saving',message:''});try{const normalized=canonical(next);if(previousStatus==='connected'){const raw=repository.saveScoped?await repository.saveScoped(normalized,previous,state.branchRevisions,state.selectedBranchIds):await repository.save(normalized,state.revision);const result=envelope(raw);if(!sameSnapshot(applyTemplateColorChanges(previous,normalized,deletedTemplateColors),result.snapshot)||JSON.stringify(stable(deletedTemplateColorsAfter(previous,normalized,deletedTemplateColors)))!==JSON.stringify(stable(result.deleted_template_colors)))throw Error('Verifica del salvataggio non riuscita.');record(result);}else{
 const entries=[[STORAGE_KEY,normalized.data],[NOTES_KEY,normalized.notes],[VARIATIONS_KEY,normalized.variations],[SETTINGS_KEY,normalized.settings]],original=entries.map(([k])=>[k,storage.getItem(k)]);
 try{for(const [k,v] of entries)storage.setItem(k,JSON.stringify(v));}catch(error){for(const [k,v] of original){try{if(v===null)storage.removeItem(k);else storage.setItem(k,v);}catch{}}throw error;}
 emit({snapshot:normalized,status:'local'});
 }return true;}catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:previousStatus==='local'?'local':'error',message:previousStatus==='local'?'Salvataggio locale non riuscito.':error.message||'Errore durante il salvataggio. Riconnetti prima di riprovare.'});return false;}finally{locked=false;}}
 async function bulkDelete(branchId,plan,expectedRevision){
  if(disposed||locked||state.status!=='connected')return false;
  if(!bulkDeleteBranch(state.branches,[branchId])||!Number.isSafeInteger(expectedRevision)||expectedRevision!==state.branchRevisions[branchId]){emit({message:'Sede non disponibile o anteprima non aggiornata. Riconnetti prima di riprovare.'});return false;}
  let expected;try{expected=applyBulkDelete(state.snapshot,plan,branchId);}catch(error){emit({message:error.message});return false;}
  if(!plan.length)return false;
  locked=true;emit({status:'saving',message:''});
  try{
   const result=envelope(await repository.bulkDelete(branchId,plan.map(item=>item.key),expectedRevision));
   if(!sameSnapshot(expected,result.snapshot))throw Error('Verifica dell’eliminazione non riuscita. Riconnetti e controlla i dati.');
   record(result);return true;
  }catch(error){emit({...(tenant&&error.code==='SESSION_CHANGED'?{snapshot:emptySnapshot(),pending:null}:{}),status:'error',message:error.message});return false;}finally{locked=false;}
 }
 function offline(){if(repository)emit({status:'offline',message:'Connessione assente — dati locali disponibili in sola lettura'});}
 return {getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},connect,migrate,save,bulkDelete,offline,dispose:()=>{disposed=true;state={...state,snapshot:emptySnapshot(),pending:null,status:'offline'};listeners.clear();},organizationId,userId,localBackup:()=>local.snapshot,hasLocalData:local.exists};
}
