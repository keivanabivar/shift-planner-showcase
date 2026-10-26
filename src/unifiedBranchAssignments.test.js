// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const ids=['92000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000003'];

test('PostgreSQL 021: assignment unificati, multi-sede, miei turni e viewer',async()=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async index=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[index]])};
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  for(const file of files)await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  for(let i=0;i<ids.length;i++)await db.query('insert into auth.users values($1,$2,now())',[ids[i],`unified${i+1}@example.invalid`]);
  await asUser(0);
  const account=await scalar("select public.organization_onboard('Gruppo','Owner','Demo Branch Alpha') as value"),oid=account.organization_id;
  const branchA=await scalar("select id as value from public.branches where organization_id=$1 and name='Demo Branch Alpha'",[oid]);
  const branchB=(await scalar("select public.branch_create($1,'Demo Branch Beta') as value",[oid])).id;
  await scalar("select public.branch_employee_create($1,$2,'mobile','Mobile') as value",[oid,branchA]);
  await scalar("select public.branch_employee_create($1,$2,'no-login','Senza account') as value",[oid,branchB]);
  await scalar('select public.employee_branch_assignment_update($1,$2,$3::uuid[]) as value',[oid,'mobile',[branchA,branchB]]);
  const overview=await scalar('select public.employee_branch_assignment_overview($1) as value',[oid]);
  assert.deepEqual(new Set(overview.find(item=>item.employee_id==='mobile').branch_ids),new Set([branchA,branchB]));
  assert.equal(overview.find(item=>item.employee_id==='no-login').user_id,null);

  const loaded=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  const operations=[
   {kind:'shift_upsert',id:'mobile|2027-04-01',employeeId:'mobile',date:'2027-04-01',type:'Mattina',start:'09:30',end:'17:30',branchId:branchA},
   {kind:'shift_upsert',id:'mobile|2027-04-02',employeeId:'mobile',date:'2027-04-02',type:'Pomeriggio',start:'14:00',end:'22:00',branchId:branchB}
  ];
  await scalar('select public.planner_apply_branch_operations($1,$2::jsonb,$3::jsonb,null) as value',[oid,JSON.stringify(operations),JSON.stringify(loaded.branch_revisions)]);

  const ownInvite=await scalar("select public.branch_invite_create($1,'unified2@example.invalid',$2,'employee','mobile','own') as value",[oid,branchA]);
  await asUser(1);await scalar('select public.organization_invite_accept($1) as value',[ownInvite.token]);
  const own=await scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[branchA]]);
  assert.deepEqual(new Set(Object.keys(own.snapshot.data.shifts)),new Set(['mobile|2027-04-01','mobile|2027-04-02']));
  assert.deepEqual(new Set(own.selected_branch_ids),new Set([branchA,branchB]));
  assert.equal(own.snapshot.data.employees.length,1);

  await asUser(0);
  const viewerInvite=await scalar("select public.branch_invite_create($1,'unified3@example.invalid',$2,'viewer',null,'all_branches') as value",[oid,branchA]);
  await asUser(2);await scalar('select public.organization_invite_accept($1) as value',[viewerInvite.token]);
  await asUser(0);await scalar("select public.branch_member_assignments_update($1,$2,'viewer',null,'all_branches',true,$3::uuid[]) as value",[oid,ids[2],[branchA,branchB]]);
  await asUser(2);
  const branchBView=await scalar('select public.planner_load_scoped($1,$2::uuid[]) as value',[oid,[branchB]]);
  assert.deepEqual(branchBView.selected_branch_ids,[branchB]);
  assert.deepEqual(Object.keys(branchBView.snapshot.data.shifts),['mobile|2027-04-02']);
  assert.equal(new Set(branchBView.snapshot.data.employees.map(item=>item.id)).size,branchBView.snapshot.data.employees.length);
 }finally{await db.close()}
});
