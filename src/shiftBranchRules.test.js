// Synthetic showcase fixtures only; never derived from real accounts or exports.
const compatibility={schema_version:30,client_protocol:'planner-030-v1',writes_enabled:true};
import test from 'node:test';
import assert from 'node:assert/strict';
import {branchOperations,defaultShiftBranchId,employeeBranchOptions,assertAuthorizedShiftBranches} from './branchPersistence.js';
import {copyShiftValue} from './copyShifts.js';
import {createPlannerStore,emptySnapshot} from './plannerStore.js';
import {createRepository,canonical} from './persistence.js';
import {makeVariation} from './attendance.js';

const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)}};
const branches=[
 {id:'a',name:'Demo Branch Alpha',active:true,readable:true,operable:true},
 {id:'b',name:'Demo Branch Beta',active:true,readable:true,operable:true},
 {id:'c',name:'Torino',active:true,readable:true,operable:true},
 {id:'off',name:'Chiusa',active:false,readable:true,operable:true}
];

test('single-branch employee has one implicit option, so the UI needs no selector',()=>{
 const employee={id:'e',homeBranchId:'a',branchIds:['a']};
 assert.deepEqual(employeeBranchOptions(employee,branches).map(item=>item.id),['a']);
 assert.equal(defaultShiftBranchId(employee,branches,['b']),'a');
});

test('multi-branch employee gets exactly the assigned active branches',()=>{
 const employee={id:'e',homeBranchId:'a',branchIds:['b','a','off']};
 assert.deepEqual(employeeBranchOptions(employee,branches).map(item=>item.id),['a','b']);
 assert.equal(defaultShiftBranchId(employee,branches,['b']),'b');
});

test('unauthorized shift branch is rejected before persistence',()=>{
 const data={version:1,employees:[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a','b']}],shifts:{'e|2027-01-01':{type:'Riposo',off:true,branchId:'c'}}};
 assert.throws(()=>assertAuthorizedShiftBranches(data),/non è assegnata/);
});

test('an unchanged historical shift outside current assignments does not block a valid create',()=>{
 const previous=emptySnapshot(),next=emptySnapshot();
 previous.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a']}];
 previous.data.shifts={'e|2027-01-01':{type:'Riposo',off:true,branchId:'c'}};
 next.data=structuredClone(previous.data);
 next.data.shifts['e|2027-01-02']={type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:'a'};
 assert.deepEqual(branchOperations(previous,next,['a']),[{kind:'shift_upsert',id:'e|2027-01-02',employeeId:'e',date:'2027-01-02',branchId:'a',type:'Mattina',off:false,start:'09:30',end:'17:30'}]);
});

test('a newly created shift outside employee assignments is still rejected',()=>{
 const previous=emptySnapshot(),next=emptySnapshot();
 previous.data.employees=next.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a','b']}];
 next.data.shifts={'e|2027-01-02':{type:'Riposo',off:true,branchId:'c'}};
 assert.throws(()=>branchOperations(previous,next,['a','b']),/non è assegnata/);
});

test('drag copy keeps the source branch',()=>{
 assert.equal(copyShiftValue({type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:'b'},emptySnapshot().settings).branchId,'b');
});

test('successful scoped drag/drop write verifies against the complete returned snapshot',async()=>{
 const snapshot=emptySnapshot();
 snapshot.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a','b']}];
 snapshot.data.shifts={'e|2027-01-01':{type:'Riposo',off:true,branchId:'a'}};
 const envelope=value=>({organization_id:'org',revision:1,empty:false,branches,selected_branch_ids:['a','b'],branch_revisions:{a:0,b:0},snapshot:value});
 let remote=structuredClone(snapshot);
 const repository={load:async()=>envelope(remote),saveScoped:async next=>{remote=structuredClone(next);return envelope(remote)}};
 const store=createPlannerStore({storage:memory(),repository,project:'test',organizationId:'org',userId:'user'});
 assert.equal(await store.connect(),true);
 const next=structuredClone(snapshot);
 next.data.shifts['e|2027-01-02']={type:'Riposo',off:true,branchId:'a'};
 assert.equal(await store.save(next),true);
 assert.equal(store.getSnapshot().status,'connected');
 assert.ok(store.getSnapshot().snapshot.data.shifts['e|2027-01-02']);
});

test('scoped repository write requests an unfiltered verification snapshot',async()=>{
 const calls=[],snapshot=emptySnapshot();
 const request=async(_url,options)=>{if(_url.endsWith('/planner_client_compatibility'))return {ok:true,text:async()=>JSON.stringify(compatibility)};calls.push(JSON.parse(options.body));return {ok:true,text:async()=>JSON.stringify({organization_id:'org'})}};
 const repository=createRepository('https://project.supabase.co','sb_publishable_example',request,{organizationId:'org',userId:'user',getSession:async()=>({user:{id:'user'},access_token:'token'})});
 await repository.saveScoped(snapshot,snapshot,{a:0},['a']);
 assert.equal(calls[0].p_branch_ids,null);
});


function variationStore({alterReply=value=>value,fail=false}={}){
 const snapshot=emptySnapshot(),key='e|2027-01-01';
 snapshot.data.employees=[{id:'e',name:'Demo Sample 016',homeBranchId:'a',branchIds:['a','b']}];
 snapshot.data.shifts={[key]:{type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:'b'},'e|2027-01-02':{type:'Riposo',off:true,branchId:'a'}};
 snapshot.variations[key]={...makeVariation('e','2027-01-01','10','1730','Ritardo'),branchId:'b'};
 let remote=structuredClone(snapshot),revision=0;const calls=[];
 const envelope=()=>({organization_id:'org',revision,empty:false,branches,selected_branch_ids:['a','b'],branch_revisions:{a:0,b:revision},client_compatibility:compatibility,snapshot:structuredClone(remote)});
 // Match planner_load_scoped: variation branchId comes from the owning shift,
 // and SQL to_char(...,'HH24:MI') returns minute precision, not HH:MM:SS.
 const request=async(url,options)=>{
  if(url.endsWith('/planner_client_compatibility'))return {ok:true,text:async()=>JSON.stringify(compatibility)};
  const body=JSON.parse(options.body);calls.push({url,body});
  if(url.endsWith('/planner_apply_branch_operations')){
   if(fail)return {ok:false,status:500,json:async()=>({})};
   for(const op of body.p_operations){assert.equal(op.kind,'variation_upsert');const {kind,id,branchId,...value}=op;assert.equal(branchId,'b');remote.variations[id]={...value,branchId:remote.data.shifts[id].branchId};}revision++;
   return {ok:true,text:async()=>JSON.stringify(alterReply(envelope()))};
  }
  return {ok:true,text:async()=>JSON.stringify(envelope())};
 };
 const repository=createRepository('https://project.supabase.co','sb_publishable_example',request,{organizationId:'org',userId:'user',getSession:async()=>({user:{id:'user'},access_token:'token'})});
 return {key,calls,remote:()=>remote,store:createPlannerStore({storage:memory(),repository,project:'test',organizationId:'org',userId:'user'})};
}

for(const mode of ['create','edit'])test(`scoped variation ${mode} accepts server branch enrichment and updates state without reload`,async()=>{
 const {store,key,calls,remote}=variationStore();await store.connect();
 if(mode==='create'){delete remote().variations[key];await store.connect();}
 const next=structuredClone(store.getSnapshot().snapshot);
 // Same construction as saveVariation in main.jsx: no explicit branchId.
 next.variations[key]=makeVariation('e','2027-01-01','1030','17:15','Uscita anticipata','',' Aggiornata ');
 assert.equal(await store.save(next),true);
 assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
 assert.deepEqual(store.getSnapshot().snapshot.variations[key],{employeeId:'e',date:'2027-01-01',start:'10:30',end:'17:15',reason:'Uscita anticipata',customReason:'',note:'Aggiornata',branchId:'b'});
 assert.deepEqual(store.getSnapshot().snapshot.data.shifts,next.data.shifts);
 const saved=calls.at(-1).body;assert.equal(saved.p_branch_ids,null);assert.deepEqual(saved.p_operations.map(op=>[op.kind,op.branchId]),[['variation_upsert','b']]);
});

for(const field of ['start','end','reason','note','branchId'])test(`real post-save variation ${field} mismatch still fails verification`,async()=>{
 const {store,key}=variationStore({alterReply:reply=>{reply.snapshot.variations['e|2027-01-01'][field]=({start:'11:00',end:'16:00',reason:'Permesso',note:'Diversa',branchId:'a'})[field];return reply;}});
 await store.connect();const before=structuredClone(store.getSnapshot().snapshot),next=structuredClone(before);next.variations[key]=makeVariation('e','2027-01-01','1030','1715','Ritardo');
 assert.equal(await store.save(next),false);assert.match(store.getSnapshot().message,/Verifica del salvataggio/);assert.deepEqual(store.getSnapshot().snapshot,before);
});

test('variation persistence failure keeps the previous UI snapshot and reports failure',async()=>{
 const {store,key}=variationStore({fail:true});await store.connect();const before=structuredClone(store.getSnapshot().snapshot),next=structuredClone(before);next.variations[key]=makeVariation('e','2027-01-01','1030','1715','Ritardo');
 assert.equal(await store.save(next),false);assert.match(store.getSnapshot().message,/Impossibile completare/);assert.deepEqual(store.getSnapshot().snapshot,before);
});

test('canonical variation scope uses the shift branch, preserves explicit scope and does not mutate input',()=>{
 const snapshot=emptySnapshot(),key='e|2027-01-01';snapshot.data.shifts[key]={type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:'b'};snapshot.variations[key]=makeVariation('e','2027-01-01','1030','1730','Ritardo');
 assert.equal(canonical(snapshot).variations[key].branchId,'b');assert.equal(snapshot.variations[key].branchId,undefined);
 snapshot.variations[key].branchId='a';assert.equal(canonical(snapshot).variations[key].branchId,'a');
});
