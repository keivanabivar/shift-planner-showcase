// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {LEGACY_SETTINGS as DEFAULT_SETTINGS} from './legacySettings.js';
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {emptySnapshot} from './plannerStore.js';
import {makeVariation} from './attendance.js';
const A='10000000-0000-0000-0000-000000000001',B='20000000-0000-0000-0000-000000000002',C='30000000-0000-0000-0000-000000000003';
function fixture(name){const s={...emptySnapshot(),settings:structuredClone(DEFAULT_SETTINGS)};s.data.employees=[{id:'same-local-id',name}];s.data.shifts={'same-local-id|2026-10-01':makeShift('Mattina'),'same-local-id|2026-10-02':makeShift('Ferie')};s.notes=[{id:'same-note',text:`Nota ${name}`,employeeId:'same-local-id',date:''}];s.variations={'same-local-id|2026-10-01':makeVariation('same-local-id','2026-10-01','10','17:30','Ritardo')};return s;}
test('PostgreSQL: migrazioni reali, RLS, RPC e isolamento tra organizzazioni',async t=>{
 const db=new PGlite();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
 let expectedOrg=null;
 const asUser=async id=>{await db.exec('reset role; set role authenticated;');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);expectedOrg=await scalar('select public.current_organization_id() as value');};
 const load=()=>scalar('select public.planner_load() as value');
 const save=(s,revision=0,onlyEmpty=false)=>scalar('select public.planner_save($1::jsonb,$2,$3) as value',[JSON.stringify({...s,...(expectedOrg?{expected_organization_id:expectedOrg}:{})}),revision,onlyEmpty]);
 try{
 await db.exec("create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public,auth to anon,authenticated;");
 for(const file of ['001_planner.sql','002_access_and_validation.sql'])await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 // Exercise migration against populated legacy data, including old public test mode.
 await db.exec('update public.planner_access set public_test_mode=true');
 const old=fixture('Archivio');await save(old);
 await db.exec(await readFile(new URL('../supabase/migrations/003_organizations_auth.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/004_account_name_custom_presets.sql',import.meta.url),'utf8'));
 await db.query('insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now()),($3,null)',[A,B,C]);
 await t.test('dati precedenti conservati e nessuna assegnazione automatica',async()=>{
 assert.equal(await scalar('select count(*)::int as value from public.employees'),1);
 assert.equal(await scalar('select count(*)::int as value from public.shifts'),2);
 assert.equal(await scalar('select count(*)::int as value from public.notes'),1);
 assert.equal(await scalar('select count(*)::int as value from public.attendance_variations'),1);
 assert.equal(await scalar('select count(*)::int as value from public.profiles'),0);
 assert.equal(await scalar('select public_test_mode as value from public.planner_access'),false);
 });
 await asUser(A);const orgA=await scalar("select public.organization_onboard('Organizzazione A','Utente A') as value");
 await asUser(B);const orgB=await scalar("select public.organization_onboard('Organizzazione B','Utente B') as value");
 await t.test('onboarding atomico e ripetibile, email confermata obbligatoria',async()=>{
 assert.notEqual(orgA.organization_id,orgB.organization_id);assert.equal(orgA.role,'admin');
 assert.deepEqual(await scalar("select public.organization_onboard('Altro nome','Altro') as value"),orgB);
 await asUser(C);await assert.rejects(scalar("select public.organization_onboard('Nuova','Utente') as value"));await assert.rejects(load());
 });
 const a=fixture('Dipendente A'),b=fixture('Dipendente B');a.data.employees.push({id:'only-A',name:'Solo A'});b.data.employees.push({id:'only-B',name:'Solo B'});b.settings.presets.Mattina={start:'07:00',end:'15:00'};b.data.shifts['same-local-id|2026-10-01']={type:'Mattina',off:false,start:'07:00',end:'15:00'};
 await asUser(A);await save(a,0,true);await asUser(B);await save(b,0,true);
 await t.test('letture A/B isolate, stessi ID sicuri e impostazioni indipendenti',async()=>{
 for(const [uid,account,snapshot] of [[A,orgA,a],[B,orgB,b]]){
 await asUser(uid);const value=await load();assert.equal(value.organization_id,account.organization_id);assert.deepEqual(value.snapshot,snapshot);
 for(const table of ['employees','shifts','attendance_variations','notes','settings','planner_state']){
 const {rows}=await db.query(`select organization_id from public.${table}`);assert.ok(rows.length);assert.ok(rows.every(r=>r.organization_id===account.organization_id));
 }
 assert.deepEqual((await db.query('select name from public.organizations')).rows,[{name:account.organization_name}]);
 assert.deepEqual((await db.query('select user_id from public.profiles')).rows,[{user_id:uid}]);
 }
 });
 await t.test('scritture dirette e modifiche di appartenenza rifiutate',async()=>{
 for(const [uid,other] of [[A,orgB],[B,orgA]]){await asUser(uid);
 await assert.rejects(db.query('update public.employees set name=$1 where organization_id=$2',['Attacco',other.organization_id]));
 await assert.rejects(db.query('delete from public.shifts where organization_id=$1',[other.organization_id]));
 await assert.rejects(db.query('insert into public.employees(organization_id,id,name) values($1,$2,$3)',[other.organization_id,'injected','Attacco']));
 await assert.rejects(db.query('update public.profiles set organization_id=$1 where user_id=$2',[other.organization_id,uid]));
 await assert.rejects(db.query("update public.profiles set role='admin'"));
 }
 });
 await t.test('RLS blocca operazioni inter-organizzazione anche con grant DML di test',async()=>{
 await db.exec('reset role; begin; grant insert,update,delete on public.employees,public.shifts,public.notes,public.settings to authenticated;');
 try{for(const [uid,own,other] of [[A,orgA,orgB],[B,orgB,orgA]]){
 await asUser(uid);
 assert.equal((await db.query('update public.employees set name=$1 where organization_id=$2 returning id',['Attacco',other.organization_id])).rows.length,0);
 assert.equal((await db.query('delete from public.shifts where organization_id=$1 returning id',[other.organization_id])).rows.length,0);
 // Savepoints keep the transaction usable after intentionally rejected statements.
 await db.exec('savepoint denied');await assert.rejects(db.query('insert into public.employees(organization_id,id,name) values($1,$2,$3)',[other.organization_id,'bad','Attacco']));await db.exec('rollback to savepoint denied');
 await db.exec('savepoint move');await assert.rejects(db.query('update public.employees set organization_id=$1 where organization_id=$2',[other.organization_id,own.organization_id]));await db.exec('rollback to savepoint move');
 await db.exec('savepoint relation');await assert.rejects(db.query('insert into public.notes(organization_id,id,text,employee_id) values($1,$2,$3,$4)',[own.organization_id,'cross-reference','Nota',`only-${other.user_id}`]));await db.exec('rollback to savepoint relation');
 }}finally{await db.exec('reset role; rollback');}
 });
 await t.test('planner_save non sceglie il tenant e cancella solo i propri dati',async()=>{
 await asUser(A);await assert.rejects(save({...a,organization_id:orgB.organization_id},1));
 const changed=structuredClone(a);changed.data.shifts={};changed.variations={};await save(changed,1);
 await asUser(B);assert.deepEqual((await load()).snapshot,b);
 await assert.rejects(save(b,0));await assert.rejects(save(b,1,true));
 await asUser(A);assert.equal(Object.keys((await load()).snapshot.data.shifts).length,0);
 });
 await t.test('backup e importazione locali preservano ID solo nel tenant attivo',async()=>{
 await asUser(A);await save(b,2);assert.deepEqual((await load()).snapshot,b);
 await asUser(B);assert.equal((await load()).revision,1);assert.deepEqual((await load()).snapshot,b);
 });
 await t.test('richiesta precedente a un cambio organizzazione non può salvare nel nuovo tenant',async()=>{
 await asUser(A);const rev=(await load()).revision;
 await db.exec('reset role');await db.query('update public.profiles set organization_id=$1 where user_id=$2',[orgB.organization_id,A]);
 await db.exec('set role authenticated');await assert.rejects(save(a,rev));
 await db.exec('reset role');await db.query('update public.profiles set organization_id=$1 where user_id=$2',[orgA.organization_id,A]);
 await asUser(B);assert.equal((await load()).revision,1);
 });
 await t.test('un manager aggiuntivo accede solo alla propria organizzazione',async()=>{
 await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[C]);await db.query("insert into public.profiles(user_id,organization_id,full_name,role) values($1,$2,'Manager','manager')",[C,orgA.organization_id]);
 await asUser(C);const current=await load();assert.equal(current.organization_id,orgA.organization_id);assert.deepEqual((await db.query('select id from public.organizations')).rows,[{id:orgA.organization_id}]);await save(current.snapshot,current.revision);
 });
 await t.test('solo admin rinomina la propria organizzazione e il nome persiste',async()=>{
 await asUser(A);const renamed=await scalar("select public.account_update('Utente A','Organizzazione A rinominata') as value");assert.equal(renamed.organization_name,'Organizzazione A rinominata');assert.equal((await scalar('select public.account_context() as value')).organization_name,'Organizzazione A rinominata');
 await asUser(C);await assert.rejects(scalar("select public.account_update('Manager','Tentativo') as value"));
 await asUser(B);assert.equal((await scalar('select public.account_context() as value')).organization_name,'Organizzazione B');
 });
 await t.test('preset personalizzati restano isolati e conservano ID e colore',async()=>{
 await asUser(B);const before=await load(),custom=structuredClone(before.snapshot);custom.settings.presets.custom=[{id:'night-db',name:'Notte',start:'23:00',end:'07:00',color:'#7C3AED'}];custom.data.shifts['same-local-id|2026-10-05']={type:'Notte',presetId:'night-db',presetName:'Notte',presetColor:'#7C3AED',start:'23:00',end:'07:00',off:false};await save(custom,before.revision);
 const loaded=await load();assert.deepEqual(loaded.snapshot,custom);assert.equal(loaded.snapshot.data.shifts['same-local-id|2026-10-05'].presetId,'night-db');
 await asUser(A);assert.equal((await load()).snapshot.settings.presets.custom?.length||0,0);
 });
 await t.test('RPC precedenti e accesso anonimo sono chiusi',async()=>{
 await asUser(A);await assert.rejects(scalar('select public.planner_load_internal() as value'));
 await assert.rejects(scalar('select public.planner_save_internal($1::jsonb,0,false) as value',[JSON.stringify(a)]));
 await db.exec("reset role; set role anon; select set_config('request.jwt.claim.sub','',false)");
 for(const sql of ['select * from public.organizations','select * from public.employees','select * from public.settings','select public.planner_load()','select public.account_context()',"select public.organization_onboard('Bad','Bad')"]){await assert.rejects(db.query(sql));}
 await assert.rejects(save(a));
 });
 }finally{await db.close();}
});
