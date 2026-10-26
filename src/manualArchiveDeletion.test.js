// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {enableTestClient030} from '../scripts/test-client-030.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('PostgreSQL 015: eliminazione manuale Admin, isolata, auditata e idempotente',async()=>{
 const db=new PGlite(),admin='30000000-0000-0000-0000-000000000001',editor='30000000-0000-0000-0000-000000000002',viewer='30000000-0000-0000-0000-000000000003',other='30000000-0000-0000-0000-000000000004';
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 const asUser=async id=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to anon,authenticated;");
  const dir=new URL('../supabase/migrations/',import.meta.url);for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await enableTestClient030(db);
  await db.query('insert into auth.users values($1,$2,now()),($3,$4,now()),($5,$6,now()),($7,$8,now())',[admin,'admin@example.invalid',editor,'editor@example.invalid',viewer,'viewer@example.invalid',other,'other@example.invalid']);
  await asUser(admin);const oid=(await scalar("select public.organization_onboard('Azienda','Admin') as value")).organization_id;
  await asUser(other);const otherOid=(await scalar("select public.organization_onboard('Altra','Altro') as value")).organization_id;
  await db.exec('reset role');
  await db.query("insert into public.profiles(user_id,organization_id,full_name,role,is_active) values($1,$2,'Editor','editor',true),($3,$2,'Viewer','viewer',true)",[editor,oid,viewer]);
  await db.query("insert into public.employees(organization_id,id,name) values($1,'e1','Demo Sample 016'),($2,'e2','DemoBeta')",[oid,otherOid]);
  const past=await scalar("select to_char(date_trunc('month',current_date)-interval '2 months','YYYY-MM-DD') as value"),current=await scalar("select to_char(date_trunc('month',current_date),'YYYY-MM-DD') as value"),future=await scalar("select to_char(date_trunc('month',current_date)+interval '1 month','YYYY-MM-DD') as value");
  const seed=async(targetOid,employee,date,label)=>{await db.query("select set_config('planner.retention_organization_id',$1,false),set_config('planner.retention_month_start',$2,false)",[targetOid,date]);await db.query("insert into public.shifts(organization_id,id,employee_id,date,type,start_time,end_time) values($1,$2,$3,$4,'Mattina','09:30','17:30')",[targetOid,`${employee}|${date}`,employee,date]);await db.query('insert into public.notes(organization_id,id,text,date,employee_id) values($1,$2,$3,$4,$5)',[targetOid,`note-${label}`,label,date,employee]);};
  await seed(oid,'e1',past,'delete');await seed(otherOid,'e2',past,'keep');await seed(oid,'e1',current,'current');await seed(oid,'e1',future,'future');
  await db.query("insert into public.archive_months(organization_id,month_start,state,deletion_scheduled_at,grace_until) values($1,$2,'scheduled_deletion',now(),now()),($1,$3,'archived',null,null),($1,$4,'archived',null,null)",[oid,past,current,future]);

  await asUser(admin);let archive=await scalar('select public.archive_list($1) as value',[oid]);const pastItem=archive.months.find(item=>item.month_start===past);
  assert.equal(archive.retention_months,null);assert.equal(pastItem.state,'archived');assert.equal(pastItem.approaching_deletion,false);
  await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,'ELIMINA SBAGLIATO']),/Invalid archive deletion confirmation/);
  assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[oid,past]),1);
  await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,current,'ELIMINA']),/Only completed archived months/);
  await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,future,'ELIMINA']),/Only completed archived months/);
  const expected=await scalar("select 'ELIMINA '||(case extract(month from $1::date) when 1 then 'GENNAIO' when 2 then 'FEBBRAIO' when 3 then 'MARZO' when 4 then 'APRILE' when 5 then 'MAGGIO' when 6 then 'GIUGNO' when 7 then 'LUGLIO' when 8 then 'AGOSTO' when 9 then 'SETTEMBRE' when 10 then 'OTTOBRE' when 11 then 'NOVEMBRE' else 'DICEMBRE' end)||' '||extract(year from $1::date)::int as value",[past]);
  await asUser(editor);await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,expected]),/Access denied/);
  await asUser(viewer);await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,expected]),/Access denied/);
  await asUser(other);await assert.rejects(scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,expected]),/Organization mismatch|Access denied/);
  await asUser(admin);const result=await scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,expected]);assert.equal(result.status,'deleted');assert.equal(result.deleted_counts.shifts,1);assert.equal(result.deleted_counts.notes,1);
  await asUser(other);assert.equal(await scalar('select count(*)::int as value from public.shifts where organization_id=$1 and date=$2',[otherOid,past]),1);
  await db.exec('reset role');assert.equal(await scalar('select count(*)::int as value from public.employees where organization_id=$1',[oid]),1);
  assert.equal(await scalar("select count(*)::int as value from public.archive_events where organization_id=$1 and month_start=$2 and action='manual_archive_deleted' and actor_user_id=$3 and details->>'source'='manual archive deletion'",[oid,past,admin]),1);
  await asUser(admin);
  const repeated=await scalar('select public.archive_delete_manual($1,$2,$3) as value',[oid,past,expected]);assert.equal(repeated.status,'already_deleted');
  await db.exec('reset role');
  assert.equal(await scalar("select count(*)::int as value from public.archive_events where organization_id=$1 and month_start=$2 and action='manual_archive_deleted'",[oid,past]),1);
 }finally{await db.close();}
});

test('UI archivio nasconde retention automatica e protegge backup/eliminazione',async()=>{
 const source=await readFile(new URL('./ArchiveView.jsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/12 mesi|24 mesi|36 mesi|60 mesi|Eliminazione programmata|Ripristina/);
 assert.match(source,/I mesi archiviati vengono conservati finché un amministratore non decide di eliminarli/);
 assert.match(source,/account\.role==='admin'.*Elimina definitivamente/s);
 assert.match(source,/!backupReady\|\|confirmation!==expected/);
 assert.match(source,/Creazione del backup non riuscita\. Nessun dato è stato eliminato/);
 assert.match(source,/turni\.archive non possono ancora essere ripristinati direttamente nell’app/);
});
