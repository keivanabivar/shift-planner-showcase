// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner='93000000-0000-0000-0000-000000000001';

test('PostgreSQL 026: cancellazione Sede distingue blocchi attivi e storico',async t=>{
 const db=new PGlite(),scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const dir=new URL('../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  for(const file of files)await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  await db.query('insert into auth.users values($1,$2,now())',[owner,'owner@example.invalid']);
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const account=await scalar("select public.organization_onboard('Gruppo','Owner','Demo Branch Alpha') as value"),oid=account.organization_id;
  let primary=await scalar("select id as value from public.branches where organization_id=$1 and name='Demo Branch Alpha'",[oid]);

  await t.test('una Sede secondaria può essere disattivata, riattivata e resta attiva dopo il reload',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Demo Branch Beta') as value",[oid])).id;
   await db.exec('reset role');
   await db.query("insert into public.branch_memberships(organization_id,branch_id,user_id,role,is_primary,is_active) values($1,$2,$3,'branch_admin',true,true)",[oid,branch,owner]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const result=await scalar("select public.branch_update($1,$2,'Demo Branch Beta',false) as value",[oid,branch]);
   assert.equal(result.active,false);
   const reactivated=await scalar("select public.branch_update($1,$2,'Demo Branch Beta',true) as value",[oid,branch]);
   assert.equal(reactivated.active,true);
   const reloaded=await scalar('select public.branch_list($1) as value',[oid]);
   assert.equal(reloaded.find(item=>item.id===branch).active,true);
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action='branch_activated'",[branch]),1);
   await scalar("select public.branch_update($1,$2,'Demo Branch Beta',false) as value",[oid,branch]);
  });

  await t.test('una Sede disattivata può essere riattivata',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Genova') as value",[oid])).id;
   await scalar("select public.branch_update($1,$2,'Genova',false) as value",[oid,branch]);
   const result=await scalar("select public.branch_update($1,$2,'Genova',true) as value",[oid,branch]);
   assert.equal(result.active,true);
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action='branch_activated'",[branch]),1);
   await scalar("select public.branch_update($1,$2,'Genova',false) as value",[oid,branch]);
  });

  await t.test('l’ultima Sede attiva può essere disattivata e riattivata',async()=>{
   assert.equal((await scalar("select public.branch_update($1,$2,'Demo Branch Alpha',false) as value",[oid,primary])).active,false);
   assert.equal((await scalar("select public.branch_update($1,$2,'Demo Branch Alpha',true) as value",[oid,primary])).active,true);
  });

  await t.test('una Sede secondaria vuota può essere eliminata con conferma esatta',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Errore') as value",[oid])).id;
   let listed=await scalar('select public.branch_list($1) as value',[oid]);
   assert.equal(listed.find(item=>item.id===branch).can_delete,true);
   assert.deepEqual(listed.find(item=>item.id===branch).blocker_counts,{requests:0,cross_branch_requests:0,memberships:0,user_assignments:0,employee_assignments:0,shifts:0,notes:0,invitations:0});
   assert.deepEqual(listed.find(item=>item.id===branch).history_counts,{requests:0,cross_branch_requests:0,memberships:0,invitations:0,audit_events:1});
   await assert.rejects(scalar("select public.branch_delete_empty($1,$2,'Errore') as value",[oid,branch]),/confirmation/i);
   const deleted=await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Errore') as value",[oid,branch]);
   assert.equal(deleted.deleted,true);
   assert.equal(await scalar('select count(*)::int as value from public.branches where id=$1',[branch]),0);
  });

  await t.test('una Sede secondaria vuota resta eliminabile dopo la disattivazione',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Temporanea') as value",[oid])).id;
   await scalar("select public.branch_update($1,$2,'Temporanea',false) as value",[oid,branch]);
   const listed=await scalar('select public.branch_list($1) as value',[oid]);
   assert.equal(listed.find(item=>item.id===branch).active,false);
   assert.equal(listed.find(item=>item.id===branch).can_delete,true);
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action='branch_deactivated'",[branch]),1);
   await db.exec('reset role');
   assert.equal(await scalar('select count(*)::int as value from public.branch_planner_state where branch_id=$1',[branch]),1);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const deleted=await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Temporanea') as value",[oid,branch]);
   assert.equal(deleted.deleted,true);
   assert.equal(await scalar('select count(*)::int as value from public.branches where id=$1',[branch]),0);
  });

  await t.test('la prima Sede è eliminabile; una Sede con dipendenti resta bloccata',async()=>{
   const deleted=await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Demo Branch Alpha') as value",[oid,primary]);
   assert.equal(deleted.deleted,true);
   primary=(await scalar("select public.branch_create($1,'Demo Branch Alpha nuova') as value",[oid])).id;
   let listed=await scalar('select public.branch_list($1) as value',[oid]);
   const branch=(await scalar("select public.branch_create($1,'Torino') as value",[oid])).id;
   await scalar("select public.branch_employee_create($1,$2,'employee-torino','Demo Sample 016') as value",[oid,branch]);
   listed=await scalar('select public.branch_list($1) as value',[oid]);
   assert.equal(listed.find(item=>item.id===branch).can_delete,false);
   assert.equal(listed.find(item=>item.id===branch).blocker_counts.employee_assignments,1);
   assert.ok(listed.find(item=>item.id===branch).delete_reasons.includes('active_blockers'));
   await assert.rejects(scalar("select public.branch_delete_empty($1,$2,'ELIMINA Torino') as value",[oid,branch]),/active dependent data/i);
  });

  await t.test('gli eventi audit non bloccano e restano leggibili dopo la cancellazione',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Audit') as value",[oid])).id;
   await db.exec('reset role');
   await db.query("insert into public.branch_access_events(organization_id,branch_id,actor_user_id,action,reason) values($1,$2,$3,'recovery_started','verifica')",[oid,branch,owner]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const listed=await scalar('select public.branch_list($1) as value',[oid]);
   assert.equal(listed.find(item=>item.id===branch).can_delete,true);
   assert.equal(listed.find(item=>item.id===branch).history_counts.audit_events,2);
   await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Audit') as value",[oid,branch]);
   await db.exec('reset role');
   const retained=(await db.query("select branch_id,branch_name,action from public.branch_access_events where organization_id=$1 and branch_name='Audit' order by id",[oid])).rows;
   assert.equal(retained.length,2);
   assert.ok(retained.every(event=>event.branch_id===null));
   assert.ok(retained.some(event=>event.action==='recovery_started'));
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  });

  await t.test('richieste concluse non bloccano e conservano lo snapshot della Sede',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Storico richieste') as value",[oid])).id;
   await scalar("select public.branch_employee_create($1,$2,'employee-history','Demo Sample 020') as value",[oid,primary]);
   await db.exec('reset role');
   await db.query("insert into public.requests(organization_id,employee_id,employee_name,created_by_user_id,created_by_name,type,start_date,end_date,status,decided_by_user_id,decided_at,revoked_by_user_id,revoked_at,approval_branch_id) values($1,'employee-history','Demo Sample 020',$2,'Owner','Altro','2026-10-01','2026-10-01','revoked',$2,now(),$2,now(),$3)",[oid,owner,branch]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const item=(await scalar('select public.branch_list($1) as value',[oid])).find(value=>value.id===branch);
   assert.equal(item.can_delete,true);assert.equal(item.blocker_counts.requests,0);assert.equal(item.history_counts.requests,1);
   await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Storico richieste') as value",[oid,branch]);
   await db.exec('reset role');
   const retained=(await db.query("select approval_branch_id,approval_branch_name,status from public.requests where employee_id='employee-history'")).rows[0];
   assert.equal(retained.approval_branch_id,null);assert.equal(retained.approval_branch_name,'Storico richieste');assert.equal(retained.status,'revoked');
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  });

  await t.test('richieste pending e richieste tra sedi pending bloccano',async()=>{
   const requestBranch=(await scalar("select public.branch_create($1,'Pending') as value",[oid])).id;
   await db.exec('reset role');
   await db.query("insert into public.requests(organization_id,employee_id,employee_name,created_by_user_id,created_by_name,type,start_date,end_date,status,approval_branch_id) values($1,'employee-history','Demo Sample 020',$2,'Owner','Altro','2026-10-02','2026-10-02','pending',$3)",[oid,owner,requestBranch]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   let item=(await scalar('select public.branch_list($1) as value',[oid])).find(value=>value.id===requestBranch);
   assert.equal(item.can_delete,false);assert.equal(item.blocker_counts.requests,1);
   const crossBranch=(await scalar("select public.branch_create($1,'Cross pending') as value",[oid])).id;
   await db.exec('reset role');
   await db.query("insert into public.cross_branch_shift_requests(organization_id,employee_id,home_branch_id,destination_branch_id,shift_date,shift_type,start_time,end_time,status,proposed_by) values($1,'employee-history',$2,$3,'2026-10-03','Centrale','09:00','17:00','pending',$4)",[oid,primary,crossBranch,owner]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   item=(await scalar('select public.branch_list($1) as value',[oid])).find(value=>value.id===crossBranch);
   assert.equal(item.can_delete,false);assert.equal(item.blocker_counts.cross_branch_requests,1);
  });

  await t.test('l’ultima Sede attiva non riceve uno status speciale ed è eliminabile se vuota',async()=>{
   const branch=(await scalar("select public.branch_create($1,'Ultima attiva') as value",[oid])).id;
   await db.exec('reset role');
   await db.query('update public.branches set active=false where organization_id=$1 and id<>$2',[oid,branch]);
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
   const item=(await scalar('select public.branch_list($1) as value',[oid])).find(value=>value.id===branch);
   assert.equal(item.can_delete,true);
   assert.equal('is_last_active' in item,false);
   assert.deepEqual(item.delete_reasons,[]);
   assert.equal((await scalar("select public.branch_delete_empty($1,$2,'ELIMINA Ultima attiva') as value",[oid,branch])).deleted,true);
  });
 }finally{await db.close()}
});
