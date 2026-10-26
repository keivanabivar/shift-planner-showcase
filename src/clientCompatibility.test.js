// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {createRepository} from './persistence.js';
import {createPlannerStore} from './plannerStore.js';
import {CLIENT_PROTOCOL,READ_RPCS,compatibleForWrite,gateClientRpc,withClientProtocol} from './clientCompatibility.js';
import {legacy029Client,enableTestClient030} from '../scripts/test-client-030.mjs';

const owner='31000000-0000-0000-0000-000000000001';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
test('protocol header preserves Data API credentials and never reaches Auth login/recovery',async()=>{
 const calls=[],request=withClientProtocol(async(input,init)=>{calls.push({input,init});});
 for(const path of ['/auth/v1/token','/auth/v1/recover','/rest/v1/rpc/account_update'])await request('https://local.invalid'+path,{headers:{Authorization:'Bearer local',apikey:'public'},method:'POST',body:'{}'});
 assert.equal(new Headers(calls[0].init.headers).has('x-planner-protocol'),false);assert.equal(new Headers(calls[1].init.headers).has('x-planner-protocol'),false);
 assert.equal(calls[2].init.headers.get('x-planner-protocol'),CLIENT_PROTOCOL);assert.equal(calls[2].init.headers.get('Authorization'),'Bearer local');assert.equal(calls[2].init.headers.get('apikey'),'public');
});
test('compatibility protocol rejects missing/unknown/disabled state and account RPCs fail closed',async()=>{
 for(const value of [null,{}, {schema_version:29,client_protocol:CLIENT_PROTOCOL,writes_enabled:true},
  {schema_version:30,client_protocol:'future',writes_enabled:true},{schema_version:30,client_protocol:CLIENT_PROTOCOL,writes_enabled:false}])assert.equal(compatibleForWrite(value),false);
 const calls=[];const client=gateClientRpc({rpc:async name=>{calls.push(name);return name==='planner_client_compatibility'?{data:null,error:{code:'PGRST202'}}:{data:{},error:null};}});
 assert.equal((await client.rpc('account_update',{manager_name:'Changed'})).error.code,'CLIENT_UPDATE_REQUIRED');
 assert.deepEqual(calls,['planner_client_compatibility']);await client.rpc('account_context');assert.equal(calls.at(-1),'account_context');
});

test('real database/client matrix: 029/030, closed rollout, old browsers and rollback, race, RPC coverage and grants',async t=>{
 const db=new PGlite(),legacy=await legacy029Client();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const dir=new URL('../supabase/migrations/',import.meta.url);
 let oid,store,oldStore,closeAfterProbe=false;const mutations=[];
 const asOwner=async()=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);};
 const load=async()=>{await db.query("select set_config('request.path','/rpc/planner_load_scoped',false)");return scalar('select public.planner_load_scoped($1,null) as value',[oid]);};
 const request=async(url,options)=>{
  const args=JSON.parse(options.body),name=url.split('/').at(-1);
  await db.query("select set_config('request.path',$1,false)",['/rpc/'+name]);
  await db.query("select set_config('request.headers',$1,false)",[JSON.stringify(Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),v])))]);
  try{
   let result;
   if(name==='planner_client_compatibility'){
    result=await scalar('select public.planner_client_compatibility() as value');
    if(closeAfterProbe){closeAfterProbe=false;await db.exec('reset role');await db.query('select planner_private.set_client_writes(false,$1)',[CLIENT_PROTOCOL]);await asOwner();}
   }else if(name==='planner_load_scoped')result=await load();
   else if(name==='planner_apply_branch_operations'){
    mutations.push(name);result=await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(args.p_operations),JSON.stringify(args.p_expected_revisions)]);
   }else throw Error('Unexpected test RPC: '+name);
   return {ok:true,text:async()=>JSON.stringify(result)};
  }catch(error){return {ok:false,status:400,json:async()=>({code:error.code==='42883'?'PGRST202':error.code,message:error.message})};}
 };
 const context={organizationId:null,userId:owner,getSession:async()=>({access_token:'local',user:{id:owner}})};
 const repository=client=>client.createRepository('https://local.invalid','sb_publishable_local',request,{...context,organizationId:oid});
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  for(const f of (await readdir(dir)).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=29).sort())await db.exec(await readFile(new URL(f,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now())',[owner,'matrix@example.invalid']);await asOwner();
  oid=(await scalar("select public.organization_onboard('Matrix','Owner') as value")).organization_id;
  const branch=await scalar('select id as value from public.branches where organization_id=$1',[oid]);
  await scalar("select public.branch_employee_create($1,$2,'matrix','Matrix employee') as value",[oid,branch]);
  const template={id:'31000000-0000-0000-0000-000000000010',branchId:branch,name:'Mattina',start:'08:00',end:'15:00',color:'#112233'};
  await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'template_upsert',...template}]),JSON.stringify((await load()).branch_revisions)]);
  await t.test('new frontend + 029: visible data, readonly store, direct repository writes never reach mutation RPC',async()=>{
   const repo=repository({createRepository});store=createPlannerStore({storage:storage(),repository:repo,organizationId:oid,userId:owner});
   assert.equal(await store.connect(),true);assert.equal(store.getSnapshot().status,'readonly');assert.match(store.getSnapshot().message,/Ricarica la pagina/);
   const before=await load(),next=structuredClone(before.snapshot);next.settings.presets.custom[0].start='09:00';
   assert.equal(await store.save(next,{updateTemplateTimes:[template.id]}),false);
   await assert.rejects(repo.saveScoped(next,before.snapshot,before.branch_revisions),{code:'CLIENT_UPDATE_REQUIRED'});
   assert.equal(mutations.length,0);assert.deepEqual(await load(),before);
  });
  await db.exec('reset role');await db.exec(await readFile(new URL('030_planner_review_improvements.sql',dir),'utf8'));await asOwner();
  await t.test('030 starts closed; old and new clients can read and no client can write',async()=>{
   assert.equal((await scalar('select public.planner_client_compatibility() as value')).writes_enabled,false);
   oldStore=legacy.createPlannerStore({storage:storage(),repository:repository(legacy),organizationId:oid,userId:owner});assert.equal(await oldStore.connect(),true);
   const before=await load(),next=structuredClone(before.snapshot);next.settings.presets.custom[0].name='Old rename';
   assert.equal(await oldStore.save(next),false);assert.doesNotMatch(oldStore.getSnapshot().message,/Verifica del salvataggio/);assert.deepEqual(await load(),before);
   await store.connect();assert.equal(store.getSnapshot().status,'readonly');
  });
  await db.exec('reset role');await enableTestClient030(db);await asOwner();
  await t.test('old frontend + 030 after reopening / frontend rollback: fail before rename commit, reads remain available',async()=>{
   await oldStore.connect();const before=await load(),next=structuredClone(before.snapshot);next.settings.presets.custom[0].name='Rollback rename';
   assert.equal(await oldStore.save(next),false);assert.doesNotMatch(oldStore.getSnapshot().message,/Verifica del salvataggio/);assert.deepEqual(await load(),before);
   await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-planner-protocol':'planner-029', 'user-agent':'Legacy browser'})]);
   await assert.rejects(scalar("select public.account_update('Old browser') as value"),{code:'P0030'});
  });
  await t.test('new frontend + 030: compatible write succeeds and later closure rejects after preflight atomically',async()=>{
   await store.connect();assert.equal(store.getSnapshot().status,'connected');let next=structuredClone(store.getSnapshot().snapshot);next.settings.presets.custom[0].name='Nuova mattina';
   assert.equal(await store.save(next),true,store.getSnapshot().message);assert.equal((await load()).snapshot.settings.presets.custom[0].name,'Nuova mattina');
   const before=await load();next=structuredClone(before.snapshot);next.settings.presets.custom[0].name='Must not commit';closeAfterProbe=true;
   assert.equal(await store.save(next),false);assert.equal(store.getSnapshot().status,'readonly');
   const after=await load();assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(after.branch_revisions,before.branch_revisions);assert.equal(after.revision,before.revision);
  });
  await t.test('all authenticated mutation RPCs gated; table DML, private setter and old implementation aliases unavailable',async()=>{
   const functions=(await db.query("select p.proname,p.prosrc,oidvectortypes(p.proargtypes) types from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prorettype<>'trigger'::regtype and has_function_privilege('authenticated',p.oid,'EXECUTE')")).rows;
   const writers=functions.filter(f=>!READ_RPCS.has(f.proname));assert.ok(writers.length>=40);
   for(const f of writers){
    assert.match(f.prosrc,/begin perform planner_private.assert_client_write\(\);/i,f.proname);
    const args=f.types?f.types.split(', ').map(type=>'null::'+type).join(','):'';
    await assert.rejects(db.query(`select public.${f.proname}(${args})`),{code:'P0030'},f.proname);
   }
   assert.equal(await scalar("select count(*)::int as value from pg_tables where schemaname='public' and (has_table_privilege('authenticated',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('anon',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE'))"),0);
   await assert.rejects(db.query("select planner_private.set_client_writes(true,'planner-030-v1')"),/permission denied/);
   await assert.rejects(db.query('select public.planner_apply_branch_operations_028(null,null,null,null)'),/permission denied/);
   await db.exec('reset role');
   // Simulate an already-running/overlooked SECURITY DEFINER body. The table
   // statement guard catches it even without a gate check in the RPC body.
   await db.exec("create function public.test_legacy_write() returns void language sql security definer set search_path='' as $$update public.employees set name='Unsafe legacy write' where id='matrix'$$;grant execute on function public.test_legacy_write() to authenticated");
   await asOwner();const before=await load();await assert.rejects(db.query('select public.test_legacy_write()'),{code:'P0030'});assert.deepEqual(await load(),before);
   await db.exec('reset role;drop function public.test_legacy_write()');
   await db.exec("create function public.test_legacy_archive_write() returns void language sql security definer set search_path='' as $$update public.archive_months set exceptional_edit_until=now()$$;grant execute on function public.test_legacy_archive_write() to authenticated");
   await asOwner();await db.query("select set_config('request.path','/rpc/archive_exceptional_edit_begin',false)");
   await assert.rejects(db.query('select public.test_legacy_archive_write()'),{code:'P0030'});
   await db.exec('reset role;drop function public.test_legacy_archive_write()');
   const priorGate=await scalar('select public.planner_client_compatibility() as value');
   await assert.rejects(db.exec(await readFile(new URL('030_planner_review_improvements.sql',dir),'utf8')),/already exists/);
   await db.exec('rollback');assert.deepEqual(await scalar('select public.planner_client_compatibility() as value'),priorGate);await asOwner();
   // Missing gate state is fail closed, never an implicit allow.
   await db.exec('reset role');await db.query('delete from planner_private.client_write_gate');await asOwner();
   await assert.rejects(db.query("select public.account_update('Missing gate')"),{code:'P0030'});
  });
 }finally{store?.dispose();oldStore?.dispose();await db.close();}
});
