// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {createPlannerStore,sameSnapshot} from './plannerStore.js';
import {createRepository} from './persistence.js';
const owner='30000000-0000-0000-0000-000000000001',viewer='30000000-0000-0000-0000-000000000002';

test('030 local database: names, future time choice, semantic status styles and atomic session Undo',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 let store;
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const f of (await readdir(dir)).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),'utf8'));
  await enableTestClient030(db);
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now())',[owner,'owner30@example.invalid',viewer,'viewer30@example.invalid']);
  await asUser(owner);const oid=(await scalar("select public.organization_onboard('030 local','Owner') as value")).organization_id;
  const a=await scalar('select id as value from public.branches where organization_id=$1',[oid]);
  const b=(await scalar("select public.branch_create($1,'Demo Branch Beta') as value",[oid])).id;
  await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[a,b]]);
  await scalar("select public.branch_employee_create($1,$2,'aa','Demo Sample 016') as value",[oid,a]);
  await scalar("select public.employee_branch_assignment_update($1,'aa',$2::uuid[]) as value",[oid,[a,b]]);
  const today=await scalar('select current_date::text as value'),tomorrow=await scalar("select (current_date+1)::text as value"),later=await scalar("select (current_date+2)::text as value"),past=await scalar("select (date_trunc('month',current_date)-interval '2 months')::date::text as value");
  const load=()=>scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  const apply=async(ops,revisions)=>(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(ops),JSON.stringify(revisions||(await load()).branch_revisions)]));
  const ta={id:'30000000-0000-0000-0000-000000000010',branchId:a,name:'Mattina',start:'08:00',end:'15:00',color:'#112233'},tb={...ta,id:'30000000-0000-0000-0000-000000000011',branchId:b};
  await apply([{kind:'template_upsert',...ta},{kind:'template_upsert',...tb}]);
  const shift=(d,t=ta)=>({kind:'shift_upsert',id:'aa|'+d,employeeId:'aa',date:d,type:t.name,presetId:t.id,presetName:t.name,presetColor:t.color,start:'07:30',end:'15:45',off:false,branchId:t.branchId});
  await db.exec('reset role');await db.query('insert into public.archive_months(organization_id,month_start) values($1,$2)',[oid,past]);await asUser(owner);
  await scalar("select public.archive_exceptional_edit_begin($1,$2,'MODIFICA ECCEZIONALE') as value",[oid,past]);
  await apply([shift(past),shift(today),shift(tomorrow),shift(later,tb)]);
  await scalar('select public.archive_exceptional_edit_end($1,$2) as value',[oid,past]);
  const beforeRows=await db.query('select id,start_time,end_time,created_at,updated_at from public.shifts where organization_id=$1 order by id',[oid]);
  const request=async(url,options)=>{
   const args=JSON.parse(options.body);await db.query("select set_config('request.headers',$1,false)",[JSON.stringify(options.headers)]);try{
    let result;
    if(url.endsWith('/planner_client_compatibility'))result=await scalar('select public.planner_client_compatibility() as value');
    else if(url.endsWith('/planner_load_scoped'))result=await load();
    else if(url.endsWith('/planner_apply_branch_operations'))result=await apply(args.p_operations,args.p_expected_revisions);
    else if(url.endsWith('/planner_undo'))result=await scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,args.p_token,JSON.stringify(args.p_expected_revisions)]);
    else if(url.endsWith('/planner_bulk_delete_shifts'))result=await scalar('select public.planner_bulk_delete_shifts($1,$2,$3::text[],$4) as value',[oid,args.p_branch_id,args.p_shift_ids,args.p_expected_revision]);
    else if(url.endsWith('/user_branch_employee_order_save'))result=await scalar('select public.user_branch_employee_order_save($1,$2,$3::text[],$4::text[]) as value',[oid,args.p_branch_id,args.p_expected_order,args.p_employee_order]);
    else throw Error('Unexpected local RPC');
    return {ok:true,text:async()=>JSON.stringify(result)};
   }catch(error){return {ok:false,status:400,json:async()=>({code:error.code,message:error.message})};}
  };
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const repository=createRepository('https://in-memory.invalid','sb_publishable_local',request,{organizationId:oid,userId:owner,getSession:async()=>({access_token:'local',user:{id:owner}})});
  store=createPlannerStore({storage,repository,organizationId:oid,userId:owner});assert.equal(await store.connect(),true);
  await t.test('rename updates linked archived/today/future names; hours/timestamps and other Sede preserved',async()=>{
   const next=structuredClone(store.getSnapshot().snapshot);next.settings.presets.custom.find(t=>t.id===ta.id).name='Mattina nuova';
   assert.equal(await store.save(next),true,store.getSnapshot().message);
   const loaded=await load();assert.ok(sameSnapshot(store.getSnapshot().snapshot,loaded.snapshot));
   for(const d of [past,today,tomorrow])assert.equal(loaded.snapshot.data.shifts['aa|'+d].presetName,'Mattina nuova');
   assert.equal(loaded.snapshot.data.shifts['aa|'+later].presetName,'Mattina');
   assert.deepEqual((await db.query('select id,start_time,end_time,created_at,updated_at from public.shifts where organization_id=$1 order by id',[oid])).rows,beforeRows.rows);
  });
  await t.test('No changes only new assignments; Yes changes every linked future time but never today/past',async()=>{
   let next=structuredClone(store.getSnapshot().snapshot);Object.assign(next.settings.presets.custom.find(t=>t.id===ta.id),{start:'09:00',end:'16:00'});
   assert.equal(await store.save(next),true);assert.equal(store.getSnapshot().snapshot.data.shifts['aa|'+tomorrow].start,'07:30');
   next=structuredClone(store.getSnapshot().snapshot);Object.assign(next.settings.presets.custom.find(t=>t.id===ta.id),{start:'10:00',end:'17:00'});
   assert.equal(await store.save(next,{updateTemplateTimes:[ta.id],today}),true,store.getSnapshot().message);
   const shifts=store.getSnapshot().snapshot.data.shifts;
   assert.equal(shifts['aa|'+tomorrow].start,'10:00');assert.equal(shifts['aa|'+today].start,'07:30');assert.equal(shifts['aa|'+past].start,'07:30');assert.equal(shifts['aa|'+later].start,'07:30');
  });
  await t.test('status names/colors round trip per Sede without changing semantic shift type or worked hours',async()=>{
   const next=structuredClone(store.getSnapshot().snapshot);next.settings.statusStyles={[a]:{Riposo:{name:'Giorno libero',color:'#ABCDEF'}},[b]:{Riposo:{name:'Libero B',color:'#445566'}}};
   assert.equal(await store.save(next),true,store.getSnapshot().message);assert.deepEqual(store.getSnapshot().snapshot.settings.statusStyles,next.settings.statusStyles);
   await assert.rejects(apply([{kind:'status_style_upsert',branchId:a,status:'Work',name:'Bad',color:'#111111'}]),/check constraint/);
  });
  await t.test('multistep Undo interleaves add/edit/delete, variations and persisted order',async()=>{
   const baseline=structuredClone(store.getSnapshot().snapshot),key='aa|'+tomorrow;
   let next=structuredClone(baseline);next.data.shifts[key].start='11:00';assert.equal(await store.save(next,{undoable:true}),true);
   const edited=structuredClone(store.getSnapshot().snapshot);
   next=structuredClone(edited);next.variations[key]={employeeId:'aa',date:tomorrow,start:'11:15',end:'17:00',reason:'Ritardo',customReason:'',note:'Test'};assert.equal(await store.save(next,{undoable:true}),true,store.getSnapshot().message);
   assert.ok(await store.saveEmployeeOrder(a,null,['aa']));
   assert.equal(store.getSnapshot().undoDepth,3);assert.ok((await store.undo()).branch_preferences);assert.equal(store.getSnapshot().undoDepth,2);
   assert.equal(await store.undo(),true,store.getSnapshot().message);assert.ok(sameSnapshot(store.getSnapshot().snapshot,edited));
   assert.equal(await store.undo(),true,store.getSnapshot().message);assert.ok(sameSnapshot(store.getSnapshot().snapshot,baseline));
   next=structuredClone(baseline);delete next.data.shifts[key];assert.equal(await store.save(next,{undoable:true}),true);assert.equal(await store.undo(),true,store.getSnapshot().message);assert.ok(sameSnapshot(store.getSnapshot().snapshot,baseline));
   const newDate=await scalar("select (current_date+3)::text as value");next=structuredClone(baseline);next.data.shifts['aa|'+newDate]={type:'Riposo',off:true,branchId:a};assert.equal(await store.save(next,{undoable:true}),true);assert.equal(await store.undo(),true);assert.ok(sameSnapshot(store.getSnapshot().snapshot,baseline));
  });
  await t.test('bulk delete receipt restores variations and approved request provenance exactly',async()=>{
   const key='aa|'+tomorrow;let next=structuredClone(store.getSnapshot().snapshot);next.variations[key]={employeeId:'aa',date:tomorrow,start:'10:15',end:'17:00',reason:'Ritardo',customReason:'',note:'Keep'};assert.equal(await store.save(next),true);
   const original=structuredClone(store.getSnapshot().snapshot);
   const result=await scalar('select public.planner_bulk_delete_shifts($1,$2,$3::text[],$4) as value',[oid,a,[key],store.getSnapshot().branchRevisions[a]]);assert.ok(result.undo_token);
   await scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,result.undo_token,JSON.stringify(result.branch_revisions)]);assert.ok(sameSnapshot(original,(await load()).snapshot));
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,result.undo_token,JSON.stringify((await load()).branch_revisions)]),/Undo unavailable/);
   const leave=await scalar("select public.request_create($1,'aa','Ferie',$2,$2,null,null,'Undo source') as value",[oid,tomorrow]);
   const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,leave.id]);
   const approved=await scalar("select public.request_approve($1,$2,$3,$4,true,'Ok','Ferie',$5,$5,null,null) as value",[oid,leave.id,preview.expected_version,preview.expected_revision,tomorrow]);
   const source=await scalar('select to_jsonb(s) as value from public.shifts s where organization_id=$1 and id=$2',[oid,key]);
   const deleted=await apply([{kind:'shift_delete',id:key,branchId:a}]);
   await scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,deleted.undo_token,JSON.stringify(deleted.branch_revisions)]);
   assert.deepEqual(await scalar('select to_jsonb(s) as value from public.shifts s where organization_id=$1 and id=$2',[oid,key]),source);
   await scalar("select public.request_revoke($1,$2,$3,$4,true,'Restore') as value",[oid,leave.id,approved.request.version,(await load()).branch_revisions[a]]);
   await store.connect();
  });
  await t.test('real store: cancel deleted Ferie in another client, save/Undo in Sede B, reject earlier mixed restore atomically',async()=>{
   const date=await scalar("select (current_date+5)::text as value"),other=await scalar("select (current_date+6)::text as value"),key='aa|'+date,otherKey='aa|'+other;
   const leave=await scalar("select public.request_create($1,'aa','Ferie',$2,$2,null,null,'Cancellation regression') as value",[oid,date]);
   const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,leave.id]);
   const approval=await scalar("select public.request_approve($1,$2,$3,$4,true,'Ok','Ferie',$5,$5,null,null) as value",[oid,leave.id,preview.expected_version,preview.expected_revision,date]);
   await apply([shift(other)]);await store.connect();
   let next=structuredClone(store.getSnapshot().snapshot);delete next.data.shifts[key];delete next.data.shifts[otherKey];
   assert.equal(await store.save(next,{undoable:true}),true,store.getSnapshot().message);assert.equal(store.getSnapshot().undoDepth,1);
   // A separate client cancels without restoring the deleted shifts. The store
   // deliberately keeps its first receipt and stale branch revision until B saves.
   const cancelled=await scalar("select public.request_cancel($1,$2,$3,$4,false,'Other client') as value",[oid,leave.id,approval.request.version,(await load()).organization_revision]);
   assert.equal(cancelled.request.status,'cancelled');
   next=structuredClone(store.getSnapshot().snapshot);next.data.shifts['aa|'+later].start='12:45';
   assert.equal(await store.save(next,{undoable:true}),true,store.getSnapshot().message);
   assert.equal(await store.undo(),true,store.getSnapshot().message);assert.equal(store.getSnapshot().undoDepth,1);
   const before=await load();await db.exec('reset role');
   const receiptsBefore=(await db.query('select token,used_at from planner_private.planner_undo_receipts where organization_id=$1 order by token',[oid])).rows;
   await asUser(owner);assert.equal(await store.undo(),false);assert.match(store.getSnapshot().message,/altro dispositivo/);
   const after=await load();assert.deepEqual(after,before);assert.equal(after.snapshot.data.shifts[key],undefined);assert.equal(after.snapshot.data.shifts[otherKey],undefined);
   await db.exec('reset role');assert.deepEqual((await db.query('select token,used_at from planner_private.planner_undo_receipts where organization_id=$1 order by token',[oid])).rows,receiptsBefore);
   await asUser(owner);assert.equal(store.getSnapshot().undoDepth,1);await store.connect();
  });
  await t.test('request version/current validity and authorization changes reject restoration without consuming receipt',async()=>{
   const date=await scalar("select (current_date+7)::text as value"),key='aa|'+date;
   const leave=await scalar("select public.request_create($1,'aa','Ferie',$2,$2,null,null,'Validity regression') as value",[oid,date]);
   const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,leave.id]);
   await scalar("select public.request_approve($1,$2,$3,$4,true,'Ok','Ferie',$5,$5,null,null) as value",[oid,leave.id,preview.expected_version,preview.expected_revision,date]);
   const removed=await apply([{kind:'shift_delete',id:key,branchId:a}]);
   const undo=()=>scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,removed.undo_token,JSON.stringify(removed.branch_revisions)]);
   await db.exec('reset role');await db.query('update public.requests set version=version+1 where id=$1',[leave.id]);await asUser(owner);
   await assert.rejects(undo(),/changed request status or version/);
   await db.exec('reset role');await db.query('update public.requests set version=version-1 where id=$1',[leave.id]);await db.query('update public.request_shift_changes set restored_at=now() where request_id=$1',[leave.id]);await asUser(owner);
   await assert.rejects(undo(),/invalid source request/);
   await db.exec('reset role');await db.query('update public.request_shift_changes set restored_at=null where request_id=$1',[leave.id]);
   await db.query('update public.branches set active=false where id=$1',[a]);await asUser(owner);await assert.rejects(undo(),/access denied/i);
   await db.exec('reset role');await db.query('update public.branches set active=true where id=$1',[a]);await asUser(owner);
   assert.equal((await load()).snapshot.data.shifts[key],undefined);await undo();assert.ok((await load()).snapshot.data.shifts[key]);await store.connect();
  });
  await t.test('stale revision and altered row reject Undo atomically; reconnect clears history',async()=>{
   let next=structuredClone(store.getSnapshot().snapshot),key='aa|'+tomorrow;next.data.shifts[key].start='12:00';assert.equal(await store.save(next,{undoable:true}),true);
   await apply([{...shift(tomorrow),start:'13:00'}]);const rows=(await load()).snapshot;
   assert.equal(await store.undo(),false);assert.ok(sameSnapshot((await load()).snapshot,rows));assert.equal(await store.connect(),true);assert.equal(store.getSnapshot().undoDepth,0);
   const first=await apply([{...shift(tomorrow),start:'14:00'}]);await apply([{...shift(tomorrow),start:'15:00'}]);
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,first.undo_token,JSON.stringify((await load()).branch_revisions)]),/Undo conflicts/);
  });
  await t.test('full backup restore retains status styles, legacy backup resets defaults and invalid styles roll back',async()=>{
   const original=structuredClone((await load()).snapshot);
   const save=async snapshot=>{
    const loaded=await load();return scalar('select public.planner_save_effective($1::jsonb,$2,false) as value',[
     JSON.stringify({...snapshot,expected_organization_id:oid,expected_branch_revisions:loaded.branch_revisions}),loaded.organization_revision]);
   };
   await save(original);assert.ok(sameSnapshot((await load()).snapshot,original));
   const invalid=structuredClone(original);invalid.settings.statusStyles[a].Work={name:'Bad',color:'#111111'};
   const beforeInvalid=structuredClone((await load()).snapshot);await assert.rejects(save(invalid),/check constraint/);assert.ok(sameSnapshot((await load()).snapshot,beforeInvalid));
   const oldBackup=structuredClone(original);delete oldBackup.settings.statusStyles;await save(oldBackup);assert.ok(sameSnapshot((await load()).snapshot,oldBackup));
   await save(original);await store.connect();
  });
  await t.test('personal-order CAS and archive guards remain enforced',async()=>{
   const save=(expected,order)=>scalar('select public.user_branch_employee_order_save($1,$2,$3::text[],$4::text[]) as value',[oid,a,expected,order]);
   await save(null,['aa']);await assert.rejects(save(null,['aa']),/order conflict/);await save(['aa'],null);
   const receipt=await apply([{...shift(today),start:'10:30'}]);
   await db.exec('reset role');await db.query("update planner_private.planner_undo_receipts set before_rows=jsonb_set(before_rows,'{shifts,0,date}',to_jsonb($2::text)) where token=$1",[receipt.undo_token,past]);await asUser(owner);
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,receipt.undo_token,JSON.stringify((await load()).branch_revisions)]),/Archived month/);
  });
  await t.test('approved external shift Undo preserves its original assignment context; later assignment changes block it',async()=>{
   await scalar("select public.branch_employee_create($1,$2,'borrowed','Borrowed') as value",[oid,a]);
   const future=await scalar("select (current_date+4)::text as value");
   const proposed=await scalar("select public.cross_branch_shift_propose($1,'borrowed',$2,$3,'Esterno','09:00','17:00',null,null,null) as value",[oid,b,future]);
   await scalar("select public.cross_branch_shift_decide($1,$2,true,'Ok') as value",[oid,proposed.id]);
   const key='borrowed|'+future,original=await scalar('select to_jsonb(s) as value from public.shifts s where organization_id=$1 and id=$2',[oid,key]);
   const removed=await apply([{kind:'shift_delete',id:key,branchId:b}]);
   await scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,removed.undo_token,JSON.stringify(removed.branch_revisions)]);
   assert.deepEqual(await scalar('select to_jsonb(s) as value from public.shifts s where organization_id=$1 and id=$2',[oid,key]),original);
   const deleted=await apply([{kind:'shift_delete',id:key,branchId:b}]);
   await scalar("select public.employee_branch_assignment_update($1,'borrowed',$2::uuid[]) as value",[oid,[a,b]]);
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,deleted.undo_token,JSON.stringify((await load()).branch_revisions)]),/Undo conflicts/);
  });
  await t.test('receipt ownership, cross-tenant, viewer, anon and direct-table access fail closed',async()=>{
   const receipt=await apply([{...shift(tomorrow),start:'14:00'}]);
   const invite=await scalar("select public.branch_invite_create($1,'viewer30@example.invalid',$2,'viewer','aa','all_branches') as value",[oid,a]);await asUser(viewer);await scalar('select public.organization_invite_accept($1) as value',[invite.token]);
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',[oid,receipt.undo_token,JSON.stringify(receipt.branch_revisions)]),/Undo unavailable/);
   await assert.rejects(apply([{kind:'status_style_upsert',branchId:a,status:'Riposo',name:'Bad',color:'#111111'}]),/access denied/i);
   await assert.rejects(db.query('select * from planner_private.planner_undo_receipts'),/permission denied/);
   await assert.rejects(db.query('select * from public.branch_status_styles'),/permission denied/);
   await assert.rejects(scalar('select public.planner_undo($1,$2,$3::jsonb) as value',['30000000-0000-0000-0000-000000000099',receipt.undo_token,JSON.stringify(receipt.branch_revisions)]),/Organization|Access denied/i);
   await db.exec('reset role;set role anon');await assert.rejects(load(),/permission denied/);
  });
 }finally{store?.dispose();await db.close();}
});
