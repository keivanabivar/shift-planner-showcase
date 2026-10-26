// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner='95000000-0000-0000-0000-000000000001';

test('PostgreSQL 027: zero, una o più Sedi sono stati organizzativi validi',async()=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  for(const file of files)await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  await db.query('insert into auth.users values($1,$2,now())',[owner,'owner027@example.invalid']);
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const account=await scalar("select public.organization_onboard('Gruppo','Owner','Prima sede') as value"),oid=account.organization_id;
  let branches=await scalar('select public.branch_list($1) as value',[oid]);
  assert.equal(branches.length,1);
  assert.equal(branches[0].name,'Prima sede');
  assert.equal('is_primary' in branches[0],false);
  assert.equal('is_last_active' in branches[0],false);
  assert.equal(await scalar('select count(*)::int as value from public.branch_memberships where organization_id=$1 and user_id=$2',[oid,owner]),0);

  await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Prima sede') as value",[oid,branches[0].id]);
  branches=await scalar('select public.branch_list($1) as value',[oid]);
  assert.deepEqual(branches,[]);
  const emptyPlanner=await scalar('select public.planner_load_scoped($1,null) as value',[oid]);
  assert.deepEqual(emptyPlanner.branches,[]);
  assert.deepEqual(emptyPlanner.selected_branch_ids,[]);
  assert.equal(emptyPlanner.empty,true);

  const recreated=(await scalar("select public.branch_create($1,'Nuova sede') as value",[oid])).id;
  assert.equal((await scalar('select public.branch_list($1) as value',[oid]))[0].id,recreated);
  await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Nuova sede') as value",[oid,recreated]);
  const later=(await scalar("select public.branch_create($1,'Sede principale') as value",[oid])).id;
  const laterItem=(await scalar('select public.branch_list($1) as value',[oid])).find(x=>x.id===later);
  assert.equal(laterItem.name,'Sede principale');
  assert.equal(laterItem.can_delete,true);
 }finally{await db.close()}
});
