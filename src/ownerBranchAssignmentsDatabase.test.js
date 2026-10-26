// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner='94000000-0000-0000-0000-000000000001';
const branchAdmin='94000000-0000-0000-0000-000000000002';

test('PostgreSQL 024: Owner e assegnazioni operative sono indipendenti',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async id=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])};
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  await Promise.all([[owner,'owner024@example.invalid'],[branchAdmin,'admin024@example.invalid']].map(row=>db.query('insert into auth.users values($1,$2,now())',row)));
  for(const file of files)await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  await asUser(owner);
  const account=await scalar("select public.organization_onboard('Gruppo','Owner','Demo Branch Alpha') as value"),oid=account.organization_id;
  const primary=await scalar("select id as value from public.branches where organization_id=$1 and name='Demo Branch Alpha'",[oid]);
  const secondary=(await scalar("select public.branch_create($1,'DOLCE') as value",[oid])).id;
  await db.exec('reset role');
  await db.query("insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary,is_active) values($1,$2,$3,'branch_admin',true,true)",[oid,secondary,owner]);
  await db.query('insert into public.user_branch_assignments(organization_id,user_id,branch_id) values($1,$2,$3),($1,$2,$4) on conflict do nothing',[oid,owner,primary,secondary]);
  await asUser(owner);

  await t.test('Owner può togliere tutte le Sedi e conserva gli accessi amministrativi organizzativi',async()=>{
   const updated=await scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[]]);
   assert.deepEqual(updated.branch_ids,[]);
   const profile=(await db.query('select role,organization_role,is_active from public.profiles where user_id=$1',[owner])).rows[0];
   assert.deepEqual(profile,{role:'admin',organization_role:'owner',is_active:true});
   assert.equal((await scalar('select public.branch_list($1) as value',[oid])).length,2);
   assert.equal((await scalar('select public.branch_access_overview($1) as value',[oid])).find(x=>x.user_id===owner).role,'branch_admin');
  });

  await t.test('reload non ripristina le assegnazioni rimosse e la Sede secondaria vuota diventa eliminabile',async()=>{
   const overview=await scalar('select public.branch_access_overview($1) as value',[oid]);
   assert.deepEqual(overview.find(x=>x.user_id===owner).branch_ids,[]);
   await db.exec('reset role');
   assert.equal(await scalar('select count(*)::int as value from public.user_branch_assignments where organization_id=$1 and user_id=$2',[oid,owner]),0);
   assert.equal(await scalar('select count(*)::int as value from public.branch_memberships where organization_id=$1 and branch_id=$2 and user_id=$3',[oid,secondary,owner]),0);
   await asUser(owner);
   assert.equal((await scalar('select public.branch_list($1) as value',[oid])).find(x=>x.id===secondary).can_delete,true);
  });

  await t.test('un Branch Admin reale resta branch-bound e protegge le regole di recovery',async()=>{
   const protectedBranch=(await scalar("select public.branch_create($1,'Protetta') as value",[oid])).id;
   const invitation=await scalar("select public.branch_invite_create($1,'admin024@example.invalid',$2,'branch_admin',null,'all_branches') as value",[oid,protectedBranch]);
   await asUser(branchAdmin);await scalar('select public.organization_invite_accept($1) as value',[invitation.token]);
   await db.exec('reset role');
   assert.equal(await scalar("select count(*)::int as value from public.branch_memberships where branch_id=$1 and user_id=$2 and role='branch_admin' and is_active",[protectedBranch,branchAdmin]),1);
   await asUser(owner);
   const details=(await scalar('select public.branch_list($1) as value',[oid])).find(x=>x.id===protectedBranch);
   assert.equal(details.blocker_counts.memberships,1);
   assert.equal(details.can_delete,false);
   await assert.rejects(scalar("select public.branch_member_assignments_update($1,$2,'viewer',null,'all_branches',true,$3::uuid[]) as value",[oid,branchAdmin,[protectedBranch]]),/last active Branch Admin/i);
   await db.exec('reset role');
   assert.equal(await scalar("select count(*)::int as value from public.branch_memberships where branch_id=$1 and user_id=$2 and role='branch_admin' and is_active",[protectedBranch,branchAdmin]),1);
   await asUser(owner);
  });

  await t.test('un non-Owner non può modificare le assegnazioni dell’Owner',async()=>{
   await asUser(branchAdmin);
   await assert.rejects(scalar("select public.branch_member_assignments_update($1,$2,'branch_admin',null,'all_branches',true,$3::uuid[]) as value",[oid,owner,[primary]]),/Access denied/i);
  });
 }finally{await db.close()}
});
