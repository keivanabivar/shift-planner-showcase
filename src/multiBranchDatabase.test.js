// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {emptySnapshot} from './plannerStore.js';

const ids=Array.from({length:8},(_,index)=>`70000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`);

test('PostgreSQL 017: multi-sede, handover, recovery e isolamento server-side',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async index=>{
  await db.exec('reset role; set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[index]]);
 };
 const migrationDir=new URL('../supabase/migrations/',import.meta.url);
 const files=(await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort();
 try{
  await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema public,auth to anon,authenticated;");
  for(const file of files.filter(name=>name<'017_'))await db.exec(await readFile(new URL(file,migrationDir),'utf8'));
  for(let index=0;index<ids.length;index++)await db.query('insert into auth.users values($1,$2,now())',[ids[index],`branch${index+1}@example.invalid`]);

  await asUser(0);
  const legacyAccount=await scalar("select public.organization_onboard('Gruppo esistente','Owner storico') as value");
  const legacy=({...emptySnapshot(),settings:structuredClone(DEFAULT_SETTINGS)});
  legacy.data.employees=[{id:'legacy-employee',name:'Dipendente storico'}];
  legacy.data.shifts={'legacy-employee|2027-01-10':makeShift('Mattina')};
  legacy.notes=[{id:'legacy-note',text:'Nota storica',date:'2027-01-10',employeeId:'legacy-employee'}];
  await scalar('select public.planner_save_effective($1::jsonb,0,true) as value',[JSON.stringify({...legacy,expected_organization_id:legacyAccount.organization_id})]);
  const legacyRequest=await scalar("select public.request_create($1,'legacy-employee','Altro','2027-01-11','2027-01-11',null,null,'Storica') as value",[legacyAccount.organization_id]);

  await db.exec('reset role');
  await db.exec(await readFile(new URL('017_multi_branch_foundation.sql',migrationDir),'utf8'));
  const oid=legacyAccount.organization_id;
  const branchA=await scalar("select id as value from public.branches where organization_id=$1 and name='Sede principale'",[oid]);

  await t.test('backfill crea la sede predefinita e conserva dati e accessi',async()=>{
   assert.ok(branchA);
   assert.equal(await scalar('select organization_role as value from public.profiles where user_id=$1',[ids[0]]),'owner');
   assert.equal(await scalar('select home_branch_id as value from public.employees where organization_id=$1 and id=$2',[oid,'legacy-employee']),branchA);
   assert.equal(await scalar('select branch_id as value from public.shifts where organization_id=$1 and id=$2',[oid,'legacy-employee|2027-01-10']),branchA);
   assert.equal(await scalar('select approval_branch_id as value from public.requests where id=$1',[legacyRequest.id]),branchA);
   assert.equal(await scalar('select branch_id as value from public.notes where organization_id=$1 and id=$2',[oid,'legacy-note']),null);
   assert.equal(await scalar("select count(*)::int as value from public.branch_memberships where branch_id=$1 and user_id=$2 and role='branch_admin' and is_primary and is_active",[branchA,ids[0]]),1);
   await asUser(0);
   assert.equal((await scalar('select public.planner_load() as value')).snapshot.data.employees.length,1);
  });

  await asUser(0);
  const branchB=(await scalar("select public.branch_create($1,'Sede B') as value",[oid])).id;
  const renamedBranch=await scalar("select public.branch_update($1,$2,'Sede B rinominata',true) as value",[oid,branchB]);
  assert.equal(renamedBranch.name,'Sede B rinominata');
  await scalar("select public.branch_employee_create($1,$2,'setup-b','Setup B') as value",[oid,branchB]);
  await scalar("select public.branch_shift_upsert($1,$2,'setup-b','2027-01-12','Mattina','09:30','17:30') as value",[oid,branchB]);
  const adminInvite=await scalar("select public.branch_invite_create($1,$2,$3,'branch_admin',null,'all_branches') as value",[oid,'branch2@example.invalid',branchB]);

  await t.test('invito Branch Admin completa handover e chiude accesso operativo Owner',async()=>{
   await asUser(1);
   const accepted=await scalar('select public.organization_invite_accept($1) as value',[adminInvite.token]);
   assert.equal(accepted.organization_role,'member');
   assert.equal(accepted.branches[0].branch_id,branchB);
   assert.equal(accepted.branches[0].role,'branch_admin');
   assert.equal(await scalar('select control_state as value from public.branches where id=$1',[branchB]),'managed');
   await asUser(0);
   await assert.rejects(scalar("select public.branch_employee_create($1,$2,'owner-after','No') as value",[oid,branchB]),/Branch access denied/);
   await assert.rejects(scalar('select public.planner_load() as value'),/Branch-scoped planner API required/);
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action='branch_handover_completed'",[branchB]),1);
  });

  await t.test('Branch Admin opera solo nella propria sede e un secondo Admin è supportato',async()=>{
   await asUser(1);
   await scalar("select public.branch_employee_create($1,$2,'employee-b','Dipendente B') as value",[oid,branchB]);
   await scalar("select public.branch_shift_upsert($1,$2,'employee-b','2027-01-13','Pomeriggio','14:00','22:00') as value",[oid,branchB]);
   await assert.rejects(scalar("select public.branch_employee_create($1,$2,'attack-a','Attacco') as value",[oid,branchA]),/Branch access denied/);
   await assert.rejects(scalar('select public.branch_create($1,$2) as value',[oid,'Escalation']),/Access denied/);
   const deputyInvite=await scalar("select public.branch_invite_create($1,$2,$3,'branch_admin',null,'all_branches') as value",[oid,'branch3@example.invalid',branchB]);
   await asUser(2);
   await scalar('select public.organization_invite_accept($1) as value',[deputyInvite.token]);
   assert.equal(await scalar("select count(*)::int as value from public.branch_memberships where branch_id=$1 and role='branch_admin' and is_active",[branchB]),2);
   await asUser(1);
   const pending=await scalar("select public.branch_invite_create($1,$2,$3,'viewer',null,'all_branches') as value",[oid,'branch7@example.invalid',branchB]);
   assert.ok((await scalar('select public.branch_invite_list($1,$2) as value',[oid,branchB])).some(item=>item.id===pending.id));
   await assert.rejects(scalar('select public.branch_invite_list($1,$2) as value',[oid,branchA]),/Branch access denied/);
   await db.query('select public.branch_invite_revoke($1,$2,$3)',[oid,branchB,pending.id]);
   assert.equal(await scalar('select public.organization_invite_check($1,$2) as value',[pending.token,'branch7@example.invalid']),false);
   await asUser(0);
   await scalar('select public.branch_primary_admin_set($1,$2,$3) as value',[oid,branchB,ids[2]]);
   assert.equal(await scalar('select is_primary as value from public.branch_memberships where branch_id=$1 and user_id=$2',[branchB,ids[2]]),true);
  });

  await t.test('inviti dipendente sono vincolati a email, sede, ruolo e visibilità',async()=>{
   await asUser(1);
   const employeeInvite=await scalar("select public.branch_invite_create($1,$2,$3,'employee','employee-b','home_branch') as value",[oid,'branch4@example.invalid',branchB]);
   await assert.rejects(db.query('update public.organization_invitations set target_branch_id=$1 where id=$2',[branchA,employeeInvite.id]),/permission denied/);
   await asUser(4);
   await assert.rejects(scalar('select public.organization_invite_accept($1) as value',[employeeInvite.token]),/Invalid or expired/);
   await asUser(3);
   const employeeAccount=await scalar('select public.organization_invite_accept($1) as value',[employeeInvite.token]);
   assert.equal(employeeAccount.employee_id,'employee-b');
   assert.equal(employeeAccount.visibility_level,'home_branch');
   assert.equal(await scalar('select home_branch_id as value from public.employees where organization_id=$1 and id=$2',[oid,'employee-b']),branchB);
  });

  await t.test('turno temporaneo richiede approvazione della sede di destinazione',async()=>{
   await asUser(0);
   const proposed=await scalar("select public.cross_branch_shift_propose($1,'legacy-employee',$2,'2027-01-14','Mattina','09:30','17:30') as value",[oid,branchB]);
   assert.equal(proposed.status,'pending');
   assert.equal(await scalar("select count(*)::int as value from public.shifts where organization_id=$1 and id='legacy-employee|2027-01-14'",[oid]),0);
   await assert.rejects(scalar('select public.cross_branch_shift_decide($1,$2,true,$3) as value',[oid,proposed.id,'auto-approvazione']),/Branch access denied/);
   await asUser(1);
   const approved=await scalar('select public.cross_branch_shift_decide($1,$2,true,$3) as value',[oid,proposed.id,'Copertura approvata']);
   assert.equal(approved.request.status,'approved');
   assert.equal(approved.shift.branch_id,branchB);
   assert.equal(await scalar("select home_branch_id as value from public.employees where organization_id=$1 and id='legacy-employee'",[oid]),branchA);
   await asUser(0);
   await assert.rejects(scalar("select public.branch_shift_upsert($1,$2,'legacy-employee','2027-01-14','Pomeriggio','14:00','22:00') as value",[oid,branchA]),/another branch/);
   const rejected=await scalar("select public.cross_branch_shift_propose($1,'legacy-employee',$2,'2027-01-15','Mattina','09:30','17:30') as value",[oid,branchB]);
   await asUser(2);
   const decision=await scalar('select public.cross_branch_shift_decide($1,$2,false,$3) as value',[oid,rejected.id,'Non disponibile']);
   assert.equal(decision.request.status,'rejected');
   assert.equal(decision.shift,null);
  });

  await t.test('richieste e note mantengono ownership e scope corretti',async()=>{
   await asUser(0);
   assert.equal(await scalar('select approval_branch_id as value from public.requests where id=$1',[legacyRequest.id]),branchA);
   const orgNote=await scalar("select public.branch_note_upsert($1,null,'org-note','Comunicazione gruppo','2027-01-16',null) as value",[oid]);
   assert.equal(orgNote.branch_id,null);
   await assert.rejects(scalar("select public.branch_note_upsert($1,$2,'owner-b','No','2027-01-16',null) as value",[oid,branchB]),/Branch access denied/);
   await asUser(1);
   const branchNote=await scalar("select public.branch_note_upsert($1,$2,'branch-note','Nota sede','2027-01-16','employee-b') as value",[oid,branchB]);
   assert.equal(branchNote.branch_id,branchB);
   await assert.rejects(scalar("select public.branch_note_upsert($1,$2,'legacy-note','Tentativo scope','2027-01-16',null) as value",[oid,branchB]),/another scope/);
   await assert.rejects(scalar("select public.branch_note_upsert($1,$2,'branch-a-note','No','2027-01-16',null) as value",[oid,branchA]),/Branch access denied/);
   await assert.rejects(scalar("select public.branch_note_upsert($1,null,'branch-org','No','2027-01-16',null) as value",[oid]),/Access denied/);
   await assert.rejects(scalar("select public.account_update('Admin B','Nome gruppo alterato') as value"),/Organization Owner/);
  });

  await t.test('own, home_branch e all_branches sono applicati dalle policy di lettura',async()=>{
   await asUser(3);
   const homeShifts=(await db.query('select employee_id,branch_id from public.shifts')).rows;
   assert.ok(homeShifts.length>0);
   assert.ok(homeShifts.every(row=>row.branch_id===branchB));
   assert.deepEqual((await db.query('select id from public.notes order by id')).rows.map(row=>row.id),['branch-note','legacy-note','org-note']);

   await asUser(0);
   const ownInvite=await scalar("select public.branch_invite_create($1,$2,$3,'employee','legacy-employee','own') as value",[oid,'branch7@example.invalid',branchA]);
   await asUser(6);
   await scalar('select public.organization_invite_accept($1) as value',[ownInvite.token]);
   const ownShifts=(await db.query('select employee_id,branch_id from public.shifts')).rows;
   assert.ok(ownShifts.length>=2);
   assert.ok(ownShifts.every(row=>row.employee_id==='legacy-employee'));

   await asUser(0);
   const allInvite=await scalar("select public.branch_invite_create($1,$2,$3,'viewer',null,'all_branches') as value",[oid,'branch8@example.invalid',branchA]);
   await asUser(7);
   await scalar('select public.organization_invite_accept($1) as value',[allInvite.token]);
   const allBranches=new Set((await db.query('select branch_id from public.shifts')).rows.map(row=>row.branch_id));
   assert.deepEqual(allBranches,new Set([branchA,branchB]));
  });

  await t.test('recovery Owner è esplicita, motivata e auditata',async()=>{
   await asUser(0);
   const opened=await scalar("select public.branch_recovery_start($1,$2,'Accesso di emergenza verificato') as value",[oid,branchB]);
   assert.equal(opened.control_state,'recovery');
   await scalar("select public.branch_employee_create($1,$2,'emergency-setup','Emergenza') as value",[oid,branchB]);
   const closed=await scalar("select public.branch_recovery_end($1,$2,'Amministratori disponibili') as value",[oid,branchB]);
   assert.equal(closed.control_state,'managed');
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action in ('recovery_started','recovery_ended')",[branchB]),2);
  });

  await t.test('rimuovere ultimo Admin apre recovery automatica e auditata',async()=>{
   await asUser(0);
   await scalar('select public.branch_admin_remove($1,$2,$3,$4) as value',[oid,branchB,ids[1],'Cambio responsabile']);
   const last=await scalar('select public.branch_admin_remove($1,$2,$3,$4) as value',[oid,branchB,ids[2],'Nessun responsabile attivo']);
   assert.equal(last.remaining_admins,0);
   assert.equal(last.control_state,'recovery');
   await scalar("select public.branch_employee_create($1,$2,'recovered','Recuperato') as value",[oid,branchB]);
   await assert.rejects(scalar("select public.branch_recovery_end($1,$2,'Fine') as value",[oid,branchB]),/Active Branch Admin required/);
   assert.equal(await scalar("select count(*)::int as value from public.branch_access_events where branch_id=$1 and action='branch_admin_removed'",[branchB]),2);
  });

  await t.test('tenant e branch ID di altra organizzazione non attraversano il confine',async()=>{
   await asUser(5);
   const other=await scalar("select public.organization_onboard('Altro gruppo','Altro Owner') as value");
   await assert.rejects(scalar("select public.branch_employee_create($1,$2,'cross-tenant','No') as value",[other.organization_id,branchB]),/Branch access denied/);
   await assert.rejects(scalar('select public.branch_list($1) as value',[oid]),/Access denied/);
   assert.equal((await db.query('select id from public.branches where id=$1',[branchB])).rows.length,0);
  });

  await t.test('helper privilegiati e DML diretta restano non invocabili',async()=>{
   await asUser(1);
   await assert.rejects(db.query('select planner_private.lock_branch_operator($1,$2,false)',[oid,branchB]),/permission denied/);
   await assert.rejects(db.query('insert into public.branch_memberships(organization_id,branch_id,user_id,role) values($1,$2,$3,$4)',[oid,branchA,ids[1],'branch_admin']),/permission denied/);
  });
 }finally{
  await db.close();
 }
});
