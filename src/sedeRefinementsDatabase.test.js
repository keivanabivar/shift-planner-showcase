// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {monthlySchedule} from './export.js';
import {normalizeEmployeeOrder} from './userPreferences.js';
import {legacy029Client} from '../scripts/test-client-030.mjs';
const {createRepository,createPlannerStore}=await legacy029Client();
import {sameSnapshot} from './plannerStore.js';
import {branchOperations} from './branchPersistence.js';
const owner='29000000-0000-0000-0000-000000000001',admin='29000000-0000-0000-0000-000000000002';

test('029 rehearsal: color-only history, archive protection, atomic conflicts and isolated personal Sede preferences',async t=>{
 const db=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async uid=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const files=(await readdir(dir)).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
  for(const f of files.filter(f=>Number(f.slice(0,3))<=28))await db.exec(await readFile(new URL(f,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now())',[owner,'owner29@example.invalid',admin,'admin29@example.invalid']);
  await asUser(owner);const oid=(await scalar("select public.organization_onboard('029 local','Owner') as value")).organization_id;
  const a=await scalar('select id as value from public.branches where organization_id=$1',[oid]),b=(await scalar("select public.branch_create($1,'Sede B') as value",[oid])).id;
  await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[a,b]]);
  for(const [id,name,bid] of [['shared','Shared',a],['aa','Demo Sample 016',a],['bb','DemoBeta',b]])await scalar('select public.branch_employee_create($1,$2,$3,$4) as value',[oid,bid,id,name]);
  await scalar("select public.employee_branch_assignment_update($1,'shared',$2::uuid[]) as value",[oid,[a,b]]);
  const load=()=>scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  const apply=async ops=>scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify((await load()).branch_revisions)]);
  const ta={id:'29000000-0000-0000-0000-000000000010',branchId:a,name:'Notte',start:'22:00',end:'06:00',color:'#111111'},tb={...ta,id:'29000000-0000-0000-0000-000000000011',branchId:b,color:'#222222'};
  await apply([{kind:'template_upsert',...ta},{kind:'template_upsert',...tb}]);
  await db.exec('reset role');await db.query("update public.shift_templates set legacy_preset_id='old-night' where id=$1",[ta.id]);
  const past=await scalar("select (date_trunc('month',current_date)-interval '2 months')::date::text as value"),future=await scalar("select (current_date+60)::text as value");
  await db.query('insert into public.archive_months(organization_id,month_start) values($1,$2)',[oid,past]);
  await asUser(owner);await scalar("select public.archive_exceptional_edit_begin($1,$2,'MODIFICA ECCEZIONALE') as value",[oid,past]);
  const snapshot=(t,color=t.color)=>({type:'Notte storica',presetId:t.id,presetName:'Notte storica',presetColor:color,start:'23:00',end:'07:30',off:false,branchId:t.branchId});
  const ops=[{kind:'shift_upsert',id:'aa|'+past,employeeId:'aa',date:past,...snapshot(ta)},
   {kind:'shift_upsert',id:'shared|'+past,employeeId:'shared',date:past,...snapshot({...ta,branchId:b},'#333333')},
   {kind:'shift_upsert',id:'aa|'+future,employeeId:'aa',date:future,...snapshot(ta)},
   {kind:'shift_upsert',id:'bb|'+future,employeeId:'bb',date:future,...snapshot(tb,'#556677')},
   {kind:'shift_upsert',id:'shared|'+future,employeeId:'shared',date:future,...snapshot({...ta,id:'unlinked'},'#444444')}];
  await apply(ops);
  await db.exec('reset role');await db.query("update public.shifts set preset_id='old-night' where organization_id=$1 and id=$2",[oid,'aa|'+past]);
  await asUser(owner);await scalar('select public.archive_exceptional_edit_end($1,$2) as value',[oid,past]);
  const leave=await scalar("select public.request_create($1,'aa','Ferie',$2,$2,null,null,'Test reversal') as value",[oid,future]);
  const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,leave.id]);
  const approved=await scalar("select public.request_approve($1,$2,$3,$4,true,'Ok','Ferie',$5,$5,null,null) as value",[oid,leave.id,preview.expected_version,preview.expected_revision,future]);
  const secondFuture=await scalar("select (current_date+62)::text as value");
  await apply([{kind:'shift_upsert',id:'aa|'+secondFuture,employeeId:'aa',date:secondFuture,...snapshot(ta)}]);
  await scalar("select public.user_planner_preferences_save($1,240,array['shared','bb','aa']) as value",[oid]);
  await scalar("select public.user_planner_visibility_save($1,array['bb']) as value",[oid]);
  const historical=async()=>{
   const result={};for(const table of ['shifts','attendance_variations','archive_months','requests','request_shift_changes','notes'])result[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as value from public.${table} t where organization_id=$1`,[oid]);return result;
  };
  await db.exec('reset role');const before=await historical();await db.exec(await readFile(new URL('029_sede_colors_and_preferences.sql',dir),'utf8'));
  assert.deepEqual(await historical(),before,'migration itself changes no operational history');
  await asUser(owner);
  // The real frontend repository/store talks only to this in-memory DB adapter.
  const storeForDb=()=>{
   const calls=[],values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
   const request=async(url,options)=>{
    const args=JSON.parse(options.body);calls.push(args);let result;
    try{
     if(url.endsWith('/planner_load_scoped'))result=await load();
     else if(url.endsWith('/planner_apply_branch_operations'))result=await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,$4::uuid[]) as value',[args.p_organization_id,JSON.stringify(args.p_operations),JSON.stringify(args.p_expected_revisions),args.p_branch_ids]);
     else throw Error('Unexpected local RPC');
     return {ok:true,text:async()=>JSON.stringify(result)};
    }catch(error){return {ok:false,status:400,json:async()=>({code:error.code})};}
   };
   const repository=createRepository('https://in-memory.invalid','sb_publishable_test',request,{organizationId:oid,userId:owner,getSession:async()=>({access_token:'local-token',user:{id:owner}})});
   return {calls,store:createPlannerStore({storage,repository,organizationId:oid,userId:owner})};
  };
  await t.test('blocker 2: real 029 trigger normalizes a copied historical color and frontend records it immediately',async()=>{
   const {store,calls}=storeForDb();assert.equal(await store.connect(),true);
   const source=structuredClone(store.getSnapshot().snapshot.data.shifts['bb|'+future]),next=structuredClone(store.getSnapshot().snapshot);
   assert.equal(source.presetColor,'#556677');assert.equal(next.settings.presets.custom.find(p=>p.id===tb.id).color,'#222222');
   const target='bb|'+secondFuture;next.data.shifts[target]={...source};
   assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts[target],{...source,presetColor:'#222222'});
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts['bb|'+future],source,'untouched historical source is not normalized');
   assert.equal(calls.at(-1).p_operations.length,1);assert.equal(calls.at(-1).p_operations[0].presetColor,'#556677');
   assert.ok(sameSnapshot(store.getSnapshot().snapshot,(await load()).snapshot));
   const original=structuredClone(store.getSnapshot().snapshot);await apply([{kind:'template_upsert',...tb}]);
   const stale=structuredClone(original);stale.data.shifts[target].start='00:30';assert.equal(await store.save(stale),false);assert.deepEqual(store.getSnapshot().snapshot,original,'stale write remains rejected');
   await apply([{kind:'shift_delete',id:target,branchId:b}]);store.dispose();
  });
  const revisionsBeforeColor=(await load()).branch_revisions;let state;
  await t.test('blocker 1: real 029 template propagation is verified without changing historical names/hours',async()=>{
   const {store,calls}=storeForDb();assert.equal(await store.connect(),true);
   const next=structuredClone(store.getSnapshot().snapshot),preset=next.settings.presets.custom.find(p=>p.id===ta.id);
   Object.assign(preset,{name:'Nuovo nome',start:'09:00',end:'17:00',color:'#998877'});
   assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().message,'');state=await load();
   assert.ok(sameSnapshot(store.getSnapshot().snapshot,state.snapshot));
   assert.equal(sameSnapshot(next,state.snapshot),false,'the old strict comparison falsely failed after the DB committed');
   assert.deepEqual(calls.at(-1).p_operations.map(op=>op.kind),['template_upsert']);
   assert.deepEqual(state.snapshot.data.shifts['aa|'+past],{...snapshot(ta),presetId:'old-night',presetColor:'#998877'});store.dispose();
  });
  assert.equal(state.branch_revisions[b],revisionsBeforeColor[b],'other Sede revision is unchanged');
  const after=await historical();
  for(const old of before.shifts){const current=after.shifts.find(s=>s.id===old.id),expected={...old};if(old.branch_id===a&&[ta.id,'old-night'].includes(old.preset_id))expected.preset_color='#998877';assert.deepEqual(current,expected,'only linked color may change, including archived timestamps');}
  for(const table of Object.keys(before).filter(t=>t!=='shifts'))assert.deepEqual(after[table],before[table]);
  assert.equal(state.snapshot.data.shifts['aa|'+past].presetColor,'#998877');
  const month=monthlySchedule(state.snapshot.data,'aa',past,state.snapshot.settings);assert.equal(month.legend[0].color,'#998877');assert.equal(month.legend[0].time,'23:00–07:30');
  await assert.rejects(apply([{kind:'template_upsert',...ta,color:'#ABCDEF'},{kind:'shift_upsert',id:'missing|'+future,employeeId:'missing',date:future,...snapshot(ta)}]),/approval required|foreign key/i);
  assert.deepEqual(await historical(),after,'rejected mixed operations roll back propagated colors');
  const stale=state.branch_revisions;await apply([{kind:'template_upsert',...ta,name:'Nuovo nome',start:'09:00',end:'17:00',color:'#998877'}]);
  await assert.rejects(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'template_upsert',...ta,color:'#ABCDEF'}]),JSON.stringify(stale)]),/revision conflict/i);
  // Restoring/copying an old snapshot resolves only its current linked color.
  const next=await scalar("select (current_date+61)::text as value");
  state=await apply([{kind:'shift_upsert',id:'aa|'+next,employeeId:'aa',date:next,...snapshot(ta)}]);
  assert.deepEqual(state.snapshot.data.shifts['aa|'+next],{...snapshot(ta),presetColor:'#998877'});
  await apply([{kind:'shift_upsert',id:'aa|'+past,employeeId:'aa',date:past,...snapshot(ta),start:'01:00'}]);
  assert.equal((await load()).snapshot.data.shifts['aa|'+past].start,'23:00','archive still blocks hours');
  await scalar("select public.request_revoke($1,$2,$3,$4,true,'Restore original snapshot') as value",[oid,leave.id,approved.request.version,(await load()).branch_revisions[a]]);
  assert.deepEqual((await load()).snapshot.data.shifts['aa|'+future],{...snapshot(ta),presetColor:'#998877'},'request reversal preserves original name/hours and resolves current color');
  const prefs=()=>scalar('select public.user_planner_preferences() as value');
  let preferences=await prefs();assert.deepEqual(preferences.employee_order,['shared','bb','aa']);assert.deepEqual(preferences.hidden_employee_ids,['bb']);assert.deepEqual(preferences.branch_preferences,{});
  const save=patch=>scalar('select public.user_branch_planner_preferences_save($1,$2,$3::text[],$4,$5) as value',[oid,patch.branchId,patch.order??null,patch.key??null,patch.direction??null]);
  await save({branchId:a,order:['aa','shared']});await save({branchId:b,order:['shared','bb']});await save({branchId:a,key:'duration',direction:'desc'});
  preferences=await prefs();assert.deepEqual(preferences.branch_preferences[a],{employee_order:['aa','shared'],template_sort:{key:'duration',direction:'desc'}});assert.deepEqual(preferences.branch_preferences[b].employee_order,['shared','bb']);
  await save({branchId:b,order:['bb','shared']});assert.deepEqual((await prefs()).branch_preferences[a],preferences.branch_preferences[a]);
  await db.exec('start transaction read only');assert.deepEqual(await prefs(),{...preferences,branch_preferences:{...preferences.branch_preferences,[b]:{...preferences.branch_preferences[b],employee_order:['bb','shared']}}});await db.exec('rollback');
  await assert.rejects(save({branchId:a,order:['bb']}),/Invalid Sede employee order/);await assert.rejects(save({branchId:a,order:['aa','aa']}),/Invalid Sede employee order/);await assert.rejects(save({branchId:a,key:'bad',direction:'asc'}),/Invalid template sort/);
  const invite=await scalar("select public.branch_invite_create($1,'admin29@example.invalid',$2,'branch_admin',null,'all_branches') as value",[oid,b]);await asUser(admin);await scalar('select public.organization_invite_accept($1) as value',[invite.token]);
  assert.deepEqual((await prefs()).branch_preferences,{});await save({branchId:b,order:['shared','bb']});await assert.rejects(save({branchId:a,order:['shared','aa']}),/scope denied/i);await assert.rejects(apply([{kind:'template_upsert',...ta,color:'#ABCDEF'}]),/access denied/i);
  await assert.rejects(db.query('select * from public.user_branch_planner_preferences'),/permission denied/i);
  await asUser(owner);assert.deepEqual((await prefs()).branch_preferences[a],preferences.branch_preferences[a]);
  await apply([{kind:'template_delete',id:ta.id,branchId:a}]);state=await load();assert.equal(state.snapshot.data.shifts['aa|'+past].presetColor,'#998877');
  await t.test('deleted template after reload → copy shift: real trigger and frontend verification preserve historical snapshots',async()=>{
   const deleting=storeForDb().store;assert.equal(await deleting.connect(),true);
   const without=structuredClone(deleting.getSnapshot().snapshot);without.settings.presets.custom=[];
   assert.equal(await deleting.save(without),true,'template deletion also verifies its new authoritative metadata');deleting.dispose();
   const {store,calls}=storeForDb();assert.equal(await store.connect(),true);
   const initial=structuredClone(store.getSnapshot().snapshot),source=initial.data.shifts['bb|'+future];
   assert.deepEqual(initial.settings.presets.custom,[]);assert.equal(source.presetColor,'#556677');
   const target='bb|'+secondFuture,next=structuredClone(initial);next.data.shifts[target]={...source};
   assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts[target],{...source,presetColor:'#222222'});
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts['bb|'+future],source);
   assert.equal(calls.at(-1).p_operations[0].presetColor,'#556677');
   assert.ok(sameSnapshot(store.getSnapshot().snapshot,(await load()).snapshot));
   const beforeStale=structuredClone(store.getSnapshot().snapshot);
   await apply([{kind:'shift_upsert',id:target,employeeId:'bb',date:secondFuture,...snapshot(tb)}]);
   const stale=structuredClone(beforeStale);stale.data.shifts[target].start='00:30';
   assert.equal(await store.save(stale),false);assert.deepEqual(store.getSnapshot().snapshot,beforeStale,'deleted metadata never bypasses stale revisions');store.dispose();
   const foreign=storeForDb().store;assert.equal(await foreign.connect(),true);
   const scoped=structuredClone(foreign.getSnapshot().snapshot),crossTarget='shared|'+secondFuture;
   scoped.data.shifts[crossTarget]={...source,branchId:a};assert.equal(await foreign.save(scoped),true);
   assert.deepEqual(foreign.getSnapshot().snapshot.data.shifts[crossTarget],{...source,branchId:a},'another Sede cannot resolve the deleted template color');
   const unauthorized=structuredClone(foreign.getSnapshot().snapshot);unauthorized.data.shifts['aa|'+secondFuture]={...source};
   const protectedSnapshot=structuredClone(foreign.getSnapshot().snapshot);assert.equal(await foreign.save(unauthorized),false);
   assert.deepEqual(foreign.getSnapshot().snapshot,protectedSnapshot,'cross-Sede assignment protections remain active');foreign.dispose();
   const onlyA=await scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[a]]);
   assert.deepEqual(onlyA.deleted_template_colors,[{id:ta.id,branchId:a,color:'#998877',legacyPresetId:'old-night'}]);
   await asUser(admin);const limited=await load();assert.deepEqual(limited.deleted_template_colors,[{id:tb.id,branchId:b,color:'#222222'}]);
   await assert.rejects(scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[a]]),/scope denied|access denied/i);await asUser(owner);
  });
  assert.deepEqual(normalizeEmployeeOrder(['aa','shared'],[{id:'shared'},{id:'aa'},{id:'new'}]),['aa','shared','new']);
  await db.exec('reset role;set role anon');await assert.rejects(prefs(),/permission denied/i);
 }finally{await db.close();}
});

test('029 legacy collision: exact deleted-template identity protects pre-029 history and frontend verification',async()=>{
 const db=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async()=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);};
 let store;
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const files=(await readdir(dir)).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
  for(const f of files.filter(f=>Number(f.slice(0,3))<=28))await db.exec(await readFile(new URL(f,dir),'utf8'));
  await db.query('insert into auth.users values($1,$2,now())',[owner,'collision29@example.invalid']);
  await asUser();const oid=(await scalar("select public.organization_onboard('029 collision','Owner') as value")).organization_id;
  const a=await scalar('select id as value from public.branches where organization_id=$1',[oid]),b=(await scalar("select public.branch_create($1,'Sede B') as value",[oid])).id;
  await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[a,b]]);
  for(const [id,name,bid] of [['aa','Demo Sample 016',a],['shared','Shared',a],['bb','DemoBeta',b]])await scalar('select public.branch_employee_create($1,$2,$3,$4) as value',[oid,bid,id,name]);
  const load=()=>scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  const apply=async ops=>scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify((await load()).branch_revisions)]);
  const deleted={id:'29000000-0000-0000-0000-000000000020',branchId:a,name:'Eliminato',start:'22:00',end:'06:00',color:'#123456'};
  const active={...deleted,id:'29000000-0000-0000-0000-000000000021',name:'Attivo',color:'#112233'};
  const foreign={...active,id:'29000000-0000-0000-0000-000000000022',branchId:b,color:'#445566'};
  await apply([deleted,active,foreign].map(t=>({kind:'template_upsert',...t})));
  await db.exec('reset role');
  await db.query('update public.shift_templates set legacy_preset_id=$1 where id=$2',[deleted.id,active.id]);
  await db.query('update public.shift_templates set legacy_preset_id=$1 where id=$2',[deleted.id,foreign.id]);
  await db.query("update public.shift_templates set legacy_preset_id='old-deleted' where id=$1",[deleted.id]);
  const past=await scalar("select (date_trunc('month',current_date)-interval '2 months')::date::text as value"),future=await scalar("select (current_date+60)::text as value"),copyDate=await scalar("select (current_date+61)::text as value");
  await db.query('insert into public.archive_months(organization_id,month_start) values($1,$2)',[oid,past]);
  await asUser();await scalar("select public.archive_exceptional_edit_begin($1,$2,'MODIFICA ECCEZIONALE') as value",[oid,past]);
  const snapshot=(template,presetId=template.id)=>({type:'Nome storico',presetName:'Nome storico',presetId,presetColor:'#778899',start:'23:15',end:'07:45',off:false,branchId:template.branchId});
  await apply([
   ...[past,future].flatMap(date=>[{kind:'shift_upsert',id:'aa|'+date,employeeId:'aa',date,...snapshot(deleted)},
    {kind:'shift_upsert',id:'shared|'+date,employeeId:'shared',date,...snapshot(active)}]),
   {kind:'shift_upsert',id:'bb|'+future,employeeId:'bb',date:future,...snapshot(foreign,deleted.id)}
  ]);
  await scalar('select public.archive_exceptional_edit_end($1,$2) as value',[oid,past]);
  await apply([{kind:'template_delete',id:deleted.id,branchId:a}]);
  const history=()=>scalar("select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') as value from public.shifts s where organization_id=$1",[oid]);
  await db.exec('reset role');const originalRows=await history();
  await db.exec(await readFile(new URL('029_sede_colors_and_preferences.sql',dir),'utf8'));
  assert.deepEqual(await history(),originalRows,'029 does not normalize existing history on application');
  await asUser();const initial=await load(),metadata=[{id:deleted.id,branchId:a,color:deleted.color,legacyPresetId:'old-deleted'}];
  assert.deepEqual(initial.deleted_template_colors,metadata);
  assert.equal(initial.snapshot.settings.presets.custom.some(t=>t.id===deleted.id),false);
  assert.equal(initial.snapshot.settings.presets.custom.find(t=>t.id===active.id).legacyPresetId,deleted.id);
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},calls=[];
  store=createPlannerStore({storage,organizationId:oid,userId:owner,repository:{load,saveScoped:async(next,previous,revisions)=>{
   const ops=branchOperations(previous,next);calls.push(ops);
   return scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify(revisions)]);
  }}});
  assert.equal(await store.connect(),true);const changed=structuredClone(store.getSnapshot().snapshot);
  Object.assign(changed.settings.presets.custom.find(t=>t.id===active.id),{name:'Nuovo nome',start:'09:00',end:'17:00',color:'#AABBCC'});
  assert.equal(await store.save(changed),true,'the DB and frontend must agree after the colliding active template color edit');
  assert.equal(store.getSnapshot().status,'connected');assert.equal(store.getSnapshot().message,'');
  assert.deepEqual(calls.at(-1).map(op=>op.kind),['template_upsert'],'historical shifts are never submitted as edits');
  for(const row of originalRows){const expected={...row,...(row.preset_id===active.id?{preset_color:'#AABBCC'}:{})};assert.deepEqual((await history()).find(s=>s.id===row.id),expected,'only the exact active template history changes, including archived timestamps');}
  let result=await load();assert.ok(sameSnapshot(store.getSnapshot().snapshot,result.snapshot));
  assert.equal(result.branch_revisions[b],initial.branch_revisions[b]);assert.deepEqual(result.deleted_template_colors,metadata);
  for(const presetId of [deleted.id,'old-deleted']){
   const copied=structuredClone(store.getSnapshot().snapshot),source=initial.snapshot.data.shifts['aa|'+future];
   copied.data.shifts['aa|'+copyDate]={...source,presetId};assert.equal(await store.save(copied),true);
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts['aa|'+copyDate],{...source,presetId,presetColor:deleted.color});
   assert.deepEqual(store.getSnapshot().snapshot.data.shifts['aa|'+future],source,'the historical source stays untouched after reload/copy');
  }
  result=await apply([{kind:'template_upsert',...foreign,color:'#DDEEFF'}]);
  assert.deepEqual(result.snapshot.data.shifts['bb|'+future],{...snapshot(foreign,deleted.id),presetColor:'#DDEEFF'},'a UUID in another Sede does not shadow the local legacy alias');
  assert.deepEqual(result.snapshot.data.shifts['aa|'+future],initial.snapshot.data.shifts['aa|'+future]);
  await store.connect();const beforeFailure=structuredClone(store.getSnapshot().snapshot);
  await apply([{kind:'template_upsert',...active,color:'#AABBCC'}]);
  const stale=structuredClone(beforeFailure);stale.settings.presets.custom.find(t=>t.id===active.id).color='#FFFFFF';
  assert.equal(await store.save(stale),false);assert.match(store.getSnapshot().message,/revision conflict/i);assert.deepEqual(store.getSnapshot().snapshot,beforeFailure);
  const beforeMalformed=await history();
  await assert.rejects(apply([{kind:'template_upsert',...active,color:'#FFFFFF'},{kind:'shift_upsert',id:'aa|'+copyDate,employeeId:'aa',date:copyDate,...snapshot(deleted),end:'99:99'}]),/Invalid shift time/);
  assert.deepEqual(await history(),beforeMalformed,'malformed mixed writes roll back template propagation');
  await assert.rejects(apply([{kind:'template_upsert',...active,branchId:b,color:'#FFFFFF'}]),/Template unavailable/);
  assert.deepEqual(await history(),beforeMalformed,'a collision never authorizes moving a template across Sedi');
 }finally{store?.dispose();await db.close();}
});
