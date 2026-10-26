// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlannerStore,emptySnapshot} from './plannerStore.js';
import {createRepository,CACHE_KEY,backupText,parseBackup} from './persistence.js';
import {STORAGE_KEY} from './schedule.js';
function storage(){const map=new Map([[STORAGE_KEY,JSON.stringify({version:1,employees:[{id:'legacy',name:'Locale privato'}],shifts:{}})]]);return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function remote(org){let result={organization_id:org,revision:0,empty:true,snapshot:emptySnapshot()};return {load:async()=>structuredClone(result),save:async(s,rev,onlyEmpty)=>{assert.equal(rev,result.revision);if(onlyEmpty)assert.equal(result.empty,true);result={organization_id:org,revision:rev+1,empty:false,snapshot:structuredClone(s)};return structuredClone(result);}};}
const store=(s,repo,org,user='user')=>createPlannerStore({storage:s,repository:repo,project:'project',organizationId:org,userId:user});
test('tenant starts empty, never displays legacy/global cache and imports only after explicit choice',async()=>{
 const s=storage(),legacy=s.getItem(STORAGE_KEY);s.setItem(`${CACHE_KEY}:project`,JSON.stringify({snapshot:JSON.parse(backupText({...emptySnapshot(),data:JSON.parse(legacy)}))}));s.setItem('turni.supabase.migrated.v1:project','true');
 const a=store(s,remote('A'),'A');assert.deepEqual(a.getSnapshot().snapshot,emptySnapshot());await a.connect();assert.equal(a.getSnapshot().status,'migration');assert.deepEqual(a.getSnapshot().snapshot,emptySnapshot());
 assert.equal(await a.migrate('local'),true);assert.equal(a.getSnapshot().snapshot.data.employees[0].name,'Locale privato');assert.equal(s.getItem(STORAGE_KEY),legacy);
 assert.equal(s.getItem('turni.supabase.migrated.v1:project:A:user'),'true');assert.equal(s.getItem('turni.supabase.migrated.v1:project:B:user'),null);
 const b=store(s,remote('B'),'B');assert.deepEqual(b.getSnapshot().snapshot,emptySnapshot());await b.connect();await b.migrate('server');assert.deepEqual(b.getSnapshot().snapshot,emptySnapshot());assert.equal(s.getItem(STORAGE_KEY),legacy);
});
test('cloud refresh and backups contain only the active organization',async()=>{
 const s=storage(),ra=remote('A'),rb=remote('B'),a=store(s,ra,'A'),b=store(s,rb,'B');await a.connect();await a.migrate('local');await b.connect();await b.migrate('server');
 const next=emptySnapshot();next.data.employees=[{id:'b',name:'Dipendente B'}];await b.save(next);
 const refreshed=store(s,rb,'B');assert.deepEqual(refreshed.getSnapshot().snapshot,emptySnapshot());await refreshed.connect();assert.deepEqual(parseBackup(backupText(refreshed.getSnapshot().snapshot)),next);
 assert.equal((await ra.load()).snapshot.data.employees[0].id,'legacy');
});
test('mismatched organization response cannot be displayed or marked migrated',async()=>{
 const s=storage(),a=store(s,remote('B'),'A');assert.equal(await a.connect(),false);assert.deepEqual(a.getSnapshot().snapshot,emptySnapshot());assert.equal(s.getItem('turni.supabase.migrated.v1:project:A:user'),null);
});
test('logout disposes a pending load and prevents cache/state repopulation',async()=>{
 const s=storage();let release;const a=store(s,{load:()=>new Promise(r=>release=r)},'A');const pending=a.connect();a.dispose();release({organization_id:'A',revision:1,empty:false,snapshot:emptySnapshot()});await pending;
 assert.deepEqual(a.getSnapshot().snapshot,emptySnapshot());assert.equal(a.getSnapshot().pending,null);assert.equal(s.getItem('turni.supabase.migrated.v1:project:A:user'),null);assert.equal(await a.save(emptySnapshot()),false);
});
test('session switch cancels requests; response mismatch is rejected',async()=>{
 let session={user:{id:'A'},access_token:'token-a'},calls=0;
 const request=async()=>{calls++;return {ok:true,text:async()=>JSON.stringify({organization_id:'B'})}};
 const repo=createRepository('https://project.supabase.co','sb_publishable_example',request,{userId:'A',organizationId:'A',getSession:async()=>session});
 await assert.rejects(repo.load(),/Organizzazione/);session={user:{id:'B'},access_token:'token-b'};await assert.rejects(repo.save(emptySnapshot(),0),/Sessione/);assert.equal(calls,1);
});
test('revoked membership clears previously visible tenant data',async()=>{
 const s=storage(),repo=remote('A'),a=store(s,repo,'A');await a.connect();await a.migrate('local');assert.equal(a.getSnapshot().snapshot.data.employees.length,1);
 repo.load=async()=>{throw Object.assign(Error('Sessione cambiata.'),{code:'SESSION_CHANGED',userFacing:true});};
 assert.equal(await a.connect(),false);assert.deepEqual(a.getSnapshot().snapshot,emptySnapshot());assert.equal(a.getSnapshot().pending,null);
});
