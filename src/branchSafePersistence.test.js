// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {branchLabelForShift,branchOperations,filterSnapshotByBranches,mergeScopedSnapshot} from './branchPersistence.js';
import {emptySnapshot} from './plannerStore.js';

const ids=Array.from({length:4},(_,index)=>`81000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`);

test('diff branch-safe non cancella dati fuori scope e conserva la sede',()=>{
 const a='a',b='b',base=emptySnapshot();
 base.data.employees=[{id:'ea',name:'A',homeBranchId:a},{id:'eb',name:'B',homeBranchId:b}];
 base.data.shifts={'ea|2027-02-01':{type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:a},'eb|2027-02-01':{type:'Pomeriggio',off:false,start:'14:00',end:'22:00',branchId:b}};
 const scoped=filterSnapshotByBranches(base,[a]),next=structuredClone(scoped);next.data.shifts['ea|2027-02-02']={type:'Riposo',off:true,branchId:a};
 const merged=mergeScopedSnapshot(base,scoped,next),ops=branchOperations(base,merged);
 assert.ok(merged.data.shifts['eb|2027-02-01']);
 assert.deepEqual(ops,[{kind:'shift_upsert',id:'ea|2027-02-02',employeeId:'ea',date:'2027-02-02',branchId:a,type:'Riposo',off:true}]);
 assert.equal(branchLabelForShift(base.data.shifts['eb|2027-02-01'],base.data.employees[1],[{id:a,name:'Demo Branch Alpha'},{id:b,name:'Demo Branch Beta'}],[a,b]),'Demo Branch Beta');
 assert.equal(branchLabelForShift({...base.data.shifts['eb|2027-02-01'],branchId:a},base.data.employees[1],[{id:a,name:'Demo Branch Alpha'}],[b]),'Demo Branch Alpha');
});

test('il selector Sede limita righe e turni senza duplicare i dipendenti tra sedi',()=>{
 const a='a',b='b',snapshot=emptySnapshot();
 snapshot.data.employees=[{id:'ea',name:'Demo Sample 016',homeBranchId:a,branchIds:[a,b]},{id:'eb',name:'DemoBeta',homeBranchId:b,branchIds:[b]}];
 snapshot.data.shifts={
  'ea|2027-02-01':{type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:a},
  'ea|2027-02-02':{type:'Pomeriggio',off:false,start:'14:00',end:'22:00',branchId:b},
  'eb|2027-02-01':{type:'Mattina',off:false,start:'09:30',end:'17:30',branchId:b}
 };
 const onlyA=filterSnapshotByBranches(snapshot,[a]),onlyB=filterSnapshotByBranches(snapshot,[b]),all=filterSnapshotByBranches(snapshot,[a,b]);
 assert.deepEqual(onlyA.data.employees.map(item=>item.id),['ea']);
 assert.deepEqual(Object.keys(onlyA.data.shifts),['ea|2027-02-01']);
 assert.deepEqual(onlyB.data.employees.map(item=>item.id),['ea','eb']);
 assert.deepEqual(Object.keys(onlyB.data.shifts),['ea|2027-02-02','eb|2027-02-01']);
 assert.deepEqual(all.data.employees.map(item=>item.id),['ea','eb']);
 assert.equal(new Set(all.data.employees.map(item=>item.id)).size,all.data.employees.length);
});

test('PostgreSQL 018: revisioni indipendenti, scope server e approvazione tra sedi',async()=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async index=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[index]])};
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  for(const file of files)await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  for(let i=0;i<ids.length;i++)await db.query('insert into auth.users values($1,$2,now())',[ids[i],`safe${i+1}@example.invalid`]);
  await asUser(0);
  const account=await scalar("select public.organization_onboard('Gruppo','Owner','Demo Branch Alpha Centro') as value"),oid=account.organization_id;
  const branchA=await scalar("select id as value from public.branches where organization_id=$1 and name='Demo Branch Alpha Centro'",[oid]);
  const branchB=(await scalar("select public.branch_create($1,'Demo Branch Beta') as value",[oid])).id;
  await scalar("select public.branch_employee_create($1,$2,'ea','Demo Sample 016') as value",[oid,branchA]);
  await scalar("select public.branch_employee_create($1,$2,'eb','DemoBeta') as value",[oid,branchB]);
  let combined=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.deepEqual(new Set(combined.selected_branch_ids),new Set([branchA,branchB]));
  assert.equal(combined.snapshot.data.employees.length,2);
  const afterA=await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'shift_upsert',id:'ea|2027-03-01',employeeId:'ea',date:'2027-03-01',type:'Mattina',start:'09:30',end:'17:30',branchId:branchA}]),JSON.stringify(combined.branch_revisions)]);
  assert.equal(afterA.branch_revisions[branchA],1);
  assert.equal(afterA.branch_revisions[branchB],0);
  await assert.rejects(scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'shift_delete',id:'ea|2027-03-01',branchId:branchA}]),JSON.stringify(combined.branch_revisions)]),/revision conflict/i);

  const invite=await scalar("select public.branch_invite_create($1,'safe2@example.invalid',$2,'branch_admin',null,'all_branches') as value",[oid,branchB]);
  await asUser(1);await scalar('select public.organization_invite_accept($1) as value',[invite.token]);
  const scopedB=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.deepEqual(scopedB.selected_branch_ids,[branchB]);
  await assert.rejects(scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[branchA]]),/scope denied/i);
  const employeeInvite=await scalar("select public.branch_invite_create($1,'safe3@example.invalid',$2,'employee','eb','home_branch') as value",[oid,branchB]);
  await asUser(2);await scalar('select public.organization_invite_accept($1) as value',[employeeInvite.token]);
  await asUser(1);
  const access=await scalar('select public.branch_access_overview($1) as value',[oid]);
  assert.ok(access.some(item=>item.user_id===ids[2]&&item.branch_id===branchB&&item.role==='employee'));
  const updatedAccess=await scalar("select public.branch_member_update($1,$2,$3,'employee','eb','own',true) as value",[oid,branchB,ids[2]]);
  assert.equal(updatedAccess.visibility_level,'own');
  await asUser(0);
  const viewerInvite=await scalar("select public.branch_invite_create($1,'safe4@example.invalid',$2,'viewer',null,'all_branches') as value",[oid,branchA]);
  await asUser(3);await scalar('select public.organization_invite_accept($1) as value',[viewerInvite.token]);
  await asUser(0);
  await scalar("select public.branch_member_update($1,$2,$3,'viewer',null,'all_branches',true) as value",[oid,branchB,ids[3]]);
  const movedViewer=await scalar('select public.branch_access_overview($1) as value',[oid]);
  assert.ok(movedViewer.some(item=>item.user_id===ids[3]&&item.branch_id===branchB&&item.role==='viewer'));
  await asUser(3);
  const viewerScope=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.deepEqual(viewerScope.selected_branch_ids,[branchB]);
  assert.deepEqual(viewerScope.snapshot.data.employees.map(item=>item.id),['eb']);
  assert.deepEqual(Object.keys(viewerScope.snapshot.data.shifts),[]);
  await asUser(1);
  const afterB=await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify([{kind:'shift_upsert',id:'eb|2027-03-01',employeeId:'eb',date:'2027-03-01',type:'Pomeriggio',start:'14:00',end:'22:00',branchId:branchB}]),JSON.stringify(scopedB.branch_revisions)]);
  assert.equal(afterB.branch_revisions[branchB],1);
  await asUser(3);
  const viewerAfterShift=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.deepEqual(Object.keys(viewerAfterShift.snapshot.data.shifts),['eb|2027-03-01']);
  await assert.rejects(scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[branchA]]),/scope denied/i);
  await asUser(1);
  const leave=await scalar("select public.request_create($1,'eb','Ferie','2027-03-03','2027-03-03',null,null,'Riposo') as value",[oid]);
  const preview=await scalar('select public.request_approval_preview($1,$2) as value',[oid,leave.id]);
  assert.equal(preview.expected_revision,1);
  const approved=await scalar("select public.request_approve($1,$2,$3,$4,false,'Ok','Ferie','2027-03-03','2027-03-03',null,null) as value",[oid,leave.id,preview.expected_version,preview.expected_revision]);
  assert.equal(approved.request.status,'approved');
  assert.equal(approved.revision,2);
  await assert.rejects(scalar("select public.request_revoke($1,$2,$3,1,true,'stale') as value",[oid,leave.id,approved.request.version]),/revision conflict/i);

  await asUser(0);
  const proposal=await scalar("select public.cross_branch_shift_propose($1,'ea',$2,'2027-03-02','Mattina','09:30','17:30') as value",[oid,branchB]);
  await asUser(1);
  assert.ok((await scalar('select public.cross_branch_shift_list($1) as value',[oid])).some(item=>item.id===proposal.id));
  await scalar("select public.cross_branch_shift_decide($1,$2,true,'Ok') as value",[oid,proposal.id]);
  const refreshedB=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.equal(refreshedB.branch_revisions[branchB],3);
  assert.equal(refreshedB.snapshot.data.shifts['ea|2027-03-02'].branchId,branchB);
 }finally{await db.close()}
});
